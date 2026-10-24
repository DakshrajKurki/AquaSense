"""
AQUASENSE - Grounded assistant.

Every answer is built from live model output (risk, 48 h trajectories, SHAP drivers, alerts).
If an LLM key is configured, the LLM answers the question from a full live briefing and is told
not to invent facts; the template answer is the fallback.
"""
from __future__ import annotations
import os, re
from datetime import datetime
import requests

from models import GenAIQueryResponse
from seed_data import PILOT_ZONES, CRITICAL_INFRASTRUCTURE

RANK = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "SEVERE": 3}


def pct(p: float) -> str:
    v = 100 * p
    return "<1%" if v < 1 else ">99%" if v > 99 else f"{v:.0f}%"
ALIASES = {"silk board": "zone-2", "koramangala": "zone-3", "hsr": "zone-4", "rainbow": "zone-5",
           "ecospace": "zone-6", "eco space": "zone-6", "manyata": "zone-7", "hebbal": "zone-8",
           "mahadevapura": "zone-9", "whitefield": "zone-10", "marathahalli": "zone-11", "varthur": "zone-12",
           "bommanahalli": "zone-13", "bannerghatta": "zone-14", "nayandahalli": "zone-15", "mysore road": "zone-15",
           "majestic": "zone-16", "shivajinagar": "zone-17", "rajajinagar": "zone-18", "bellandur": "zone-1"}


ON_TOPIC = ("risk", "flood", "zone", "area", "ward", "alert", "warning", "water", "drain", "lake", "storm",
            "safe", "danger", "sensor", "level", "highest", "worst", "status", "situation", "bengaluru", "bangalore",
            "city", "road", "evacuat", "shelter", "advice", "right now", "current", "summary", "overview", "model", "shap")
OFF_TOPIC = ("I can only help with **Bengaluru flood risk**: current risk by zone, the 48 h forecast, rainfall, "
             "alerts, infrastructure at risk, or a what-if storm. Try *\"Which areas are at high flood risk?\"*")


PROVIDERS = {
    "gemini": ("GEMINI_API_KEY", "GEMINI_MODEL", "gemini-3.5-flash-lite"),
    "groq": ("GROQ_API_KEY", "GROQ_MODEL", "llama-3.3-70b-versatile"),
    "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "claude-haiku-5-5"),
    "openai": ("OPENAI_API_KEY", "OPENAI_MODEL", "gpt-4o-mini"),
}


def call_llm(provider: str, key: str, model: str, system: str, user: str, timeout: float = 25) -> str:
    """One chat completion against the chosen provider. Raises on failure."""
    if provider == "gemini":
        r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                          params={"key": key}, timeout=timeout,
                          json={"system_instruction": {"parts": [{"text": system}]},
                                "contents": [{"role": "user", "parts": [{"text": user}]}],
                                "generationConfig": {"temperature": 0.3, "maxOutputTokens": 700}})
        r.raise_for_status()
        parts = r.json()["candidates"][0]["content"].get("parts", [])
        return "".join(p.get("text", "") for p in parts if not p.get("thought"))
    if provider == "anthropic":
        r = requests.post("https://api.anthropic.com/v1/messages", timeout=timeout,
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                          json={"model": model, "max_tokens": 600, "system": system,
                                "messages": [{"role": "user", "content": user}]})
        r.raise_for_status()
        return "".join(b.get("text", "") for b in r.json()["content"])
    base = {"groq": "https://api.groq.com/openai/v1", "openai": "https://api.openai.com/v1"}[provider]
    r = requests.post(f"{base}/chat/completions", timeout=timeout, headers={"Authorization": f"Bearer {key}"},
                      json={"model": model, "temperature": 0.2, "max_tokens": 600,
                            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


class AquaSenseAIAssistant:
    def __init__(self, simulator, alert_manager, engine):
        self.sim, self.alerts, self.engine = simulator, alert_manager, engine
        self.last_error: str | None = None
        self.last_ok: str | None = None

    def provider(self, browser_key: str | None = None):
        """(provider, key, model) from backend/.env, or the Gemini key saved in Settings."""
        want = os.environ.get("AQUASENSE_LLM_PROVIDER", "auto").lower()
        order = [want] if want in PROVIDERS else list(PROVIDERS)
        for name in order:
            key_var, model_var, default = PROVIDERS[name]
            if os.environ.get(key_var):
                return name, os.environ[key_var], os.environ.get(model_var, default)
        if browser_key:
            return "gemini", browser_key, os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
        return None, None, None

    def status(self) -> dict:
        name, _, model = self.provider()
        return {"provider": name, "model": model, "configured": name is not None,
                "last_error": self.last_error, "last_success": self.last_ok}

    # ------------------------------------------------------------------ context
    def _zones(self):
        rows = []
        for z in PILOT_ZONES:
            zs = self.sim.by_zone[z["id"]]
            rows.append({**zs, "name": z["name"], "ward": z["ward_number"]})
        return sorted(rows, key=lambda r: -r["probability"])

    def _context_text(self) -> str:
        """Full live briefing for the LLM: every zone, rainfall, outlook, alerts, infrastructure."""
        lines = [f"Simulated time {self.sim.sim_time:%A %Y-%m-%d %H:%M}; data mode {self.sim.data_mode}.",
                 "", "ZONES (sorted by current 6 h flood probability):"]
        for r in self._zones():
            f = r["features"]
            drivers = "; ".join(f"{d['display_name']} {'+' if d['importance_score'] > 0 else '-'}" for d in r["shap"][:3])
            lines.append(f"- {r['name']} (ward {r['ward']}): now {r['risk_level']} {pct(r['probability'])}; "
                         f"24h peak {r['peak_level_24h']} {pct(r['peak_prob_24h'])} in {r['peak_in_h']}h; "
                         f"rain last 24h {f['rain_24h_mm']:.0f}mm, forecast next 6h {f['forecast_6h_mm']:.0f}mm; "
                         f"drain level {f['water_level_m']:.2f}m; SHAP drivers (+ raises, - lowers): {drivers}")
        lines += ["", "RAINFALL:", self._rain("")[1], "", "CITY OUTLOOK:", self._forecast()[1],
                  "", "INFRASTRUCTURE:", self._infra()[1], ""]
        active = [a for a in self.alerts.get_alerts() if a.status != "RESOLVED"]
        lines.append(f"ALERTS ({len(active)} open):" if active else "ALERTS: none open.")
        lines += [f"- {a.severity} {a.trigger_type} {a.zone_name}, {pct(a.probability)}, window {a.expected_window}, "
                  f"status {a.status}" for a in active[:10]]
        return "\n".join(lines)

    # ------------------------------------------------------------------ intents
    def _zone_in(self, q: str):
        for key, zid in ALIASES.items():
            if key in q:
                return zid
        return None

    def answer_query(self, query: str, role: str = "Disaster Management Officer", api_key: str | None = None) -> GenAIQueryResponse:
        q = query.strip().lower()
        zid = self._zone_in(q)
        if any(w in q for w in ("infrastructure", "hospital", "metro", "underpass", "school", "assets")):
            intent, answer, zones = self._infra()
        elif zid:
            intent, answer, zones = self._zone(zid)
        elif "what if" in q or "scenario" in q or "%" in q or "increase" in q:
            intent, answer, zones = self._what_if(q)
        elif "rain" in q and "what if" not in q:
            intent, answer, zones = self._rain(q)
        elif any(w in q for w in ("forecast", "next", "tomorrow", "24", "48", "coming", "later", "tonight")):
            intent, answer, zones = self._forecast()
        elif any(w in q for w in ON_TOPIC):
            intent, answer, zones = self._ranking()
        else:
            intent, answer, zones = "out of scope", OFF_TOPIC, []

        sources = ["AquaSense XGBoost model (live)", "48 h risk trajectories", "SHAP explanations",
                   "Simulated KSNDMC/BBMP telemetry" if self.sim.data_mode == "simulator" else "Open-Meteo rainfall (live)"]
        if role == "Citizen":
            answer = self._citizen_wording(answer)
        provider, key, model = self.provider(api_key)
        if provider:  # LLM answers the actual question from the full briefing; template stays as fallback
            written = self._llm(provider, key, model, query, role, answer)
            if written:
                answer, sources = written, sources + [f"{provider.title()} {model}"]
                intent = f"{intent}, written by {provider.title()}"
        return GenAIQueryResponse(query=query, answer=answer, data_sources_consulted=sources,
                                  confidence_level=f"Grounded in live model output ({intent})",
                                  relevant_zones=zones, timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    def _ranking(self):
        z = self._zones()
        hot = [r for r in z if RANK[r["risk_level"]] >= 2]
        coming = [r for r in z if RANK[r["risk_level"]] < 2 and RANK[r["peak_level_24h"]] >= 2]
        lines = []
        if hot:
            lines.append(f"**{len(hot)} zone{'s are' if len(hot) != 1 else ' is'} at HIGH or SEVERE risk right now:**")
            lines += [f"- **{r['name']}**: {r['risk_level']}, {pct(r['probability'])} chance of flooding within 6 h. "
                      f"Main driver: {r['shap'][0]['display_name'].lower()}." for r in hot[:6]]
        else:
            lines.append("**No zone is at HIGH or SEVERE risk right now.**")
        if coming:
            lines.append("")
            lines.append("**Expected to escalate in the next 24 h:**")
            lines += [f"- **{r['name']}**: {r['peak_level_24h']} in about {r['hours_to_high'] or r['peak_in_h']} h" for r in coming[:5]]
        if not hot and not coming:
            top = z[:3]
            lines.append("Highest current probabilities: " + ", ".join(f"{r['name']} ({pct(r['probability'])})" for r in top) + ".")
        return "ranking", "\n".join(lines), [r["name"] for r in (hot + coming)[:6]]

    def _zone(self, zid):
        zs = self.sim.by_zone[zid]
        z = next(x for x in PILOT_ZONES if x["id"] == zid)
        f = zs["features"]
        drivers = "\n".join(
            f"- {d['display_name']} = {d['value']:.1f} ({'raises' if d['importance_score'] > 0 else 'lowers'} risk, SHAP {d['importance_score']:+.2f})"
            for d in zs["shap"][:4])
        outlook = (f"The model expects it to reach **{zs['peak_level_24h']}** in about {zs['peak_in_h']} h "
                   f"(peak {pct(zs['peak_prob_24h'])})." if zs["peak_in_h"] > 0 and RANK[zs["peak_level_24h"]] > RANK[zs["risk_level"]]
                   else "No escalation is projected in the next 24 h.")
        answer = (f"**{z['name']} (Ward {z['ward_number']})** is at **{zs['risk_level']}** risk: "
                  f"{pct(zs['probability'])} chance of waterlogging within the next 6 hours.\n\n"
                  f"Current conditions: {f['rain_24h_mm']:.0f} mm rain in 24 h, {f['forecast_6h_mm']:.0f} mm forecast for the "
                  f"next 6 h, drain level {f['water_level_m']:.2f} m.\n\n"
                  f"**What is driving this prediction (SHAP):**\n{drivers}\n\n{outlook}")
        return "zone explanation", answer, [z["name"]]

    def _infra(self):
        z = self._zones()
        risky = {r["zone_id"] for r in z if RANK[r["peak_level_24h"]] >= 2}
        hit = [i for i in CRITICAL_INFRASTRUCTURE if i["zone_id"] in risky]
        names = {x["id"]: x["name"] for x in PILOT_ZONES}
        if not hit:
            return "infrastructure", ("**No critical infrastructure** sits in a zone forecast to reach HIGH risk in the next 24 h. "
                                      f"{len(CRITICAL_INFRASTRUCTURE)} assets are monitored."), []
        lines = [f"**{len(hit)} critical asset{'s' if len(hit) != 1 else ''}** are in zones forecast to reach HIGH or SEVERE risk within 24 h:"]
        lines += [f"- **{i['name']}** ({i['type']}) in {names[i['zone_id']]}: zone peaks at "
                  f"{self.sim.by_zone[i['zone_id']]['peak_level_24h']}" for i in hit]
        lines.append("\nPrioritise access routes to hospitals, then metro and bus terminals.")
        return "infrastructure", "\n".join(lines), sorted({names[i["zone_id"]] for i in hit})

    def _forecast(self):
        traj = self.sim.latest["trajectory"]
        lv = lambda p: self.engine.model.level(float(p))
        lines = ["**Flood-risk outlook (from the 48 h rainfall forecast):**"]
        for h in (0, 3, 6, 12, 24, 48):
            row = traj[h]
            n_high = sum(1 for p in row if RANK[lv(p)] >= 2)
            fc = self.sim.latest_forecast
            rain = float(fc[max(0, h - 1)].mean()) if h else float(self.sim.rain_hist[-1].mean())
            lines.append(f"- **{'Now' if h == 0 else f'+{h} h'}**: {n_high} zone(s) HIGH or worse, city rain ~{rain:.1f} mm/h")
        z = self._zones()
        top = sorted(z, key=lambda r: -r["peak_prob_24h"])[:3]
        lines.append("\nMost exposed in the next 24 h: " + ", ".join(f"{r['name']} (peak {r['peak_level_24h']} in {r['peak_in_h']} h)" for r in top) + ".")
        return "forecast", "\n".join(lines), [r["name"] for r in top]

    def _rain(self, q):
        hist, fc = self.sim.rain_hist, self.sim.latest_forecast
        now = float(hist[-1].mean()); last24 = float(hist[-24:].mean(axis=1).sum())
        next6 = float(fc[:6].mean(axis=1).sum()); next24 = float(fc[:24].mean(axis=1).sum())
        peak_h = int(fc[:24].mean(axis=1).argmax()) + 1
        names = [z["name"] for z in PILOT_ZONES]
        wettest = sorted(range(len(names)), key=lambda i: -float(fc[:6, i].sum()))[:3]
        heavy = "heavy rain" if next6 > 25 else "moderate rain" if next6 > 8 else "light rain" if next6 > 1 else "little or no rain"
        lines = [f"**Expect {heavy} in the next 6 hours** (about {next6:.0f} mm on average across the city).",
                 f"- Right now: {now:.1f} mm/h; last 24 h: {last24:.0f} mm",
                 f"- Next 24 h: about {next24:.0f} mm, heaviest around {peak_h} h from now"]
        if next6 > 1:
            lines.append("- Most rain expected in: " + ", ".join(f"{names[i]} ({float(fc[:6, i].sum()):.0f} mm)" for i in wettest))
        return "rainfall", "\n".join(lines), [names[i] for i in wettest]

    def _what_if(self, q):
        m = re.search(r"(\d+)\s*%", q)
        mm = re.search(r"(\d+)\s*mm", q)
        base = 40.0
        intensity = float(mm.group(1)) if mm else base * (1 + (int(m.group(1)) if m else 30) / 100.0)
        s = self.sim
        res = self.engine.scenario(s.rain_hist, s.level_hist, s.hydro, intensity, 3, 40, 100, 80)
        hit = sorted([r for r in res if RANK[r["risk_level"]] >= 2], key=lambda r: -r["peak_prob"])
        area = sum(r["area_km2"] for r in hit)
        lines = [f"**Scenario: {intensity:.0f} mm/h storm for 3 h** (from current conditions):",
                 f"- Zones reaching HIGH or SEVERE: **{len(hit)} of {len(res)}** ({area:.1f} sq km)"]
        lines += [f"- {r['zone_name']}: {r['risk_level']} ({pct(r['peak_prob'])}), peak about {r['peak_hour']} h after onset"
                  for r in hit[:6]]
        lines.append("\nOpen the What-If page to change duration, drain capacity and lake levels.")
        return "what-if scenario", "\n".join(lines), [r["zone_name"] for r in hit[:6]]

    @staticmethod
    def _citizen_wording(text: str) -> str:
        """Plain-language version for residents: no model internals, no operational orders."""
        text = text.split("Immediate tactical")[0].split("Prioritise access routes")[0]
        out, reasons, in_drivers = [], [], False
        for line in text.splitlines():
            if line.startswith("**What is driving"):
                in_drivers = True
                continue
            if in_drivers and line.startswith("- "):
                if "raises risk" in line:
                    reasons.append("- " + line[2:].split(" = ")[0])
                continue
            if in_drivers and not line.strip():
                continue
            if in_drivers:
                if "is at **LOW**" not in text and reasons:
                    out += ["**Why:**"] + reasons + [""]
                in_drivers = False
            out.append(re.sub(r"\s*\((raises|lowers) risk[^)]*\)", "", line))
        return "\n".join(out).rstrip() + "\n\nStay off flooded roads and underpasses, and follow official BBMP advisories (helpline 1533)."

    # ------------------------------------------------------------------ LLM (any provider)
    def _llm(self, provider, key, model, query, role, draft):
        audience = ("a Bengaluru resident. Use plain, calm, friendly language and practical safety advice. Do not mention "
                    "SHAP, model internals, sensor IDs or give operational orders." if role == "Citizen" else
                    f"a {role} in Bengaluru's flood response team. Be precise and operational: cite zone names, "
                    "percentages, mm and hours, and say what to prioritise.")
        system = (
            "You are AquaSense Intelligence, the assistant inside AquaSense, a Bengaluru urban flood early-warning system "
            f"covering 18 BBMP zones. You are talking to {audience}\n"
            "Rules:\n"
            "1. Answer the user's actual question directly in the first sentence.\n"
            "2. For anything about current or forecast conditions, use ONLY the LIVE BRIEFING numbers. Never invent "
            "zones, numbers, alerts or events. If the briefing does not contain the answer, say so.\n"
            "3. General flood knowledge (causes of urban flooding, safety tips, what an alert level means, how the "
            "model works) is fine to explain from general knowledge.\n"
            "4. If the question has nothing to do with floods, rain, weather, safety or this system, reply in one or two "
            "sentences that you only cover Bengaluru flood risk, and suggest one relevant question.\n"
            "5. Risk levels: LOW < MEDIUM < HIGH < SEVERE. 'Probability' means chance of waterlogging within 6 hours.\n"
            "6. Never issue emergency orders to the public; point residents to BBMP helpline 1533 and official advisories.\n"
            "7. Under 170 words. Markdown: **bold** and '- ' bullets only, no headings or tables.")
        user = (f"LIVE BRIEFING\n{self._context_text()}\n\n"
                f"SYSTEM'S OWN DRAFT ANSWER (may be off-target, use only if relevant):\n{draft}\n\n"
                f"USER QUESTION: {query}")
        try:
            out = call_llm(provider, key, model, system, user)
            self.last_error, self.last_ok = None, datetime.now().strftime("%H:%M:%S")
            return out.strip() or None
        except Exception as e:
            msg = str(e)
            if key and key in msg:
                msg = msg.replace(key, "***")
            self.last_error = f"{provider}: {msg[:200]}"
            return None
