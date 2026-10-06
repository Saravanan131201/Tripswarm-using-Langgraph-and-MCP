"""
mcp_client.py

TripSwarm SerpAPI Google Flights + Exa Destination Research MCP client.
"""

import os
import json
import asyncio
from typing import Any

import certifi
from dotenv import load_dotenv
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_core.messages import SystemMessage, HumanMessage

from llm_providers import groq_llm_extract_and_structure

load_dotenv()

os.environ["SSL_CERT_FILE"]      = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

SERPAPI_API_KEY = os.getenv("SERPAPI_API_KEY")
EXA_API_KEY     = os.getenv("EXA_API_KEY")

if not SERPAPI_API_KEY:
    raise RuntimeError("Set SERPAPI_API_KEY in your .env file.")
if not EXA_API_KEY:
    raise RuntimeError("Set EXA_API_KEY in your .env file.")


# Shared MCP Client (SerpAPI + Exa)

client = MultiServerMCPClient(
    {
        "serpapi": {
            "transport": "http",
            "url": f"https://mcp.serpapi.com/{SERPAPI_API_KEY}/mcp",
        },
        "exa": {
            "transport": "streamable_http",
            "url": "https://mcp.exa.ai/mcp",
            "headers": {"x-api-key": EXA_API_KEY},
        },
    }
)


# SerpAPI MCP

serpapi_tools: dict[str, Any] = {}


async def initialize_serpapi_tools() -> None:
    global serpapi_tools
    if serpapi_tools:
        return
    tools = await client.get_tools(server_name="serpapi")
    serpapi_tools = {t.name: t for t in tools}
    if not serpapi_tools:
        raise RuntimeError("SerpAPI MCP connected but returned no tools.")
    if "search" not in serpapi_tools:
        raise RuntimeError(
            f"SerpAPI MCP 'search' tool not found. Available: {list(serpapi_tools.keys())}"
        )


async def serpapi_mcp_call(params: dict, mode: str = "complete") -> Any:
    await initialize_serpapi_tools()
    tool = serpapi_tools["search"]
    return await tool.ainvoke({"params": params, "mode": mode})



# Exa MCP

exa_search_tool: Any = None


async def initialize_exa_tools() -> None:
    global exa_search_tool
    if exa_search_tool is not None:
        return
    tools = await client.get_tools(server_name="exa")
    exa_search_tool = next((t for t in tools if t.name == "web_search_exa"), None)
    if exa_search_tool is None:
        raise RuntimeError(
            f"Exa MCP 'web_search_exa' tool not found. Available: {[t.name for t in tools]}"
        )


# Result Parsing (Flights)

def parse_flight_result(raw: Any) -> dict:
    if isinstance(raw, list):
        for block in raw:
            if isinstance(block, dict) and block.get("type") == "text":
                raw = block.get("text", "")
                break
            if isinstance(block, str):
                raw = block
                break
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"raw_text": raw}
    if isinstance(raw, dict):
        return raw
    return {"raw": str(raw)}


# Formatting helpers (Flights)

def _fmt_duration(minutes: int) -> str:
    h, m = divmod(minutes, 60)
    return f"{h}h {m}m" if m else f"{h}h"


def _fmt_legs(flights_list: list[dict]) -> list[dict]:
    legs = []
    for leg in flights_list:
        dep = leg.get("departure_airport", {})
        arr = leg.get("arrival_airport", {})
        legs.append({
            "flight_number":     leg.get("flight_number", "N/A"),
            "airline":           leg.get("airline", "N/A"),
            "airplane":          leg.get("airplane", "N/A"),
            "travel_class":      leg.get("travel_class", "Economy"),
            "departure_time":    dep.get("time", "N/A"),
            "departure_airport": f"{dep.get('id','?')} {dep.get('name','')}".strip(),
            "arrival_time":      arr.get("time", "N/A"),
            "arrival_airport":   f"{arr.get('id','?')} {arr.get('name','')}".strip(),
            "duration_fmt":      _fmt_duration(leg.get("duration", 0)),
            "overnight":         leg.get("overnight", False),
        })
    return legs


def _fmt_layovers(layovers: list[dict]) -> list[dict]:
    return [
        {
            "airport":      f"{lv.get('id','?')} {lv.get('name','')}".strip(),
            "duration_fmt": _fmt_duration(lv.get("duration", 0)),
        }
        for lv in (layovers or [])
    ]


def _extract_top3(data: dict) -> list[dict]:
    best_flights = data.get("best_flights", [])
    top3 = []
    for rank, item in enumerate(best_flights[:3], start=1):
        layovers = item.get("layovers", [])
        stops    = len(layovers)
        top3.append({
            "rank":               rank,
            "price":              item.get("price", 0),
            "trip_type":          item.get("type", "N/A"),
            "stops":              "Non-stop" if stops == 0 else f"{stops} stop{'s' if stops > 1 else ''}",
            "total_duration_fmt": _fmt_duration(item.get("total_duration", 0)),
            "legs":               _fmt_legs(item.get("flights", [])),
            "layovers":           _fmt_layovers(layovers),
            "_departure_token":   item.get("departure_token", ""),
        })
    return top3


def _extract_best_return(data: dict) -> dict | None:
    best_flights = data.get("best_flights", [])
    if not best_flights:
        return None
    cheapest = min(best_flights, key=lambda f: f.get("price", 999_999))
    layovers = cheapest.get("layovers", [])
    stops    = len(layovers)
    return {
        "price":              cheapest.get("price", 0),
        "stops":              "Non-stop" if stops == 0 else f"{stops} stop{'s' if stops > 1 else ''}",
        "total_duration_fmt": _fmt_duration(cheapest.get("total_duration", 0)),
        "legs":               _fmt_legs(cheapest.get("flights", [])),
        "layovers":           _fmt_layovers(layovers),
    }


# Flight param builder

def build_flight_params(trip: dict, flight_prefs: dict) -> dict:
    params = {
        "engine":          "google_flights",
        "departure_id":    trip["origin_iata"],
        "arrival_id":      trip["destination_iata"],
        "outbound_date":   trip["start_date"],
        "type":            flight_prefs.get("type", "1"),
        "currency":        flight_prefs.get("currency", "INR"),
        "hl":              flight_prefs.get("hl", "en"),
        "gl":              flight_prefs.get("gl", "in"),
        "adults":          flight_prefs.get("adults", 1),
        "children":        flight_prefs.get("children", 0),
        "infants_in_seat": flight_prefs.get("infants_in_seat", 0),
        "infants_on_lap":  flight_prefs.get("infants_on_lap", 0),
        "travel_class":    flight_prefs.get("travel_class", 1),
    }
    # Only include return_date for round trips (type == "1")
    if flight_prefs.get("type", "1") == "1":
        params["return_date"] = trip["end_date"]
    return params


# Public: search flights

async def search_flights_serpapi(trip: dict, flight_prefs: dict) -> dict:
    trip_type = flight_prefs.get("type", "1")
    currency  = flight_prefs.get("currency", "INR")

    # ── ONE-WAY: 2 separate one-way calls (outbound + inbound leg) ──
    if trip_type == "2":
        # Call 1: origin → destination on start_date
        outbound_params = {
            "engine":          "google_flights",
            "departure_id":    trip["origin_iata"],
            "arrival_id":      trip["destination_iata"],
            "outbound_date":   trip["start_date"],
            "type":            "2",
            "currency":        currency,
            "hl":              flight_prefs.get("hl", "en"),
            "gl":              flight_prefs.get("gl", "in"),
            "adults":          flight_prefs.get("adults", 1),
            "children":        flight_prefs.get("children", 0),
            "infants_in_seat": flight_prefs.get("infants_in_seat", 0),
            "infants_on_lap":  flight_prefs.get("infants_on_lap", 0),
            "travel_class":    flight_prefs.get("travel_class", 1),
        }

        # Call 2: destination → origin on end_date (swapped IATAs)
        inbound_params = {
            **outbound_params,
            "departure_id":  trip["destination_iata"],
            "arrival_id":    trip["origin_iata"],
            "outbound_date": trip["end_date"],
        }

        raw_out, raw_in = await asyncio.gather(
            serpapi_mcp_call(outbound_params),
            serpapi_mcp_call(inbound_params),
        )

        data_out = parse_flight_result(raw_out)
        data_in  = parse_flight_result(raw_in)

        top3_out = _extract_top3(data_out)
        top3_in  = _extract_top3(data_in)

        if not top3_out:
            raise RuntimeError(
                f"No outbound flights found for "
                f"{trip['origin_iata']} → {trip['destination_iata']} "
                f"on {trip['start_date']}."
            )
        if not top3_in:
            raise RuntimeError(
                f"No inbound flights found for "
                f"{trip['destination_iata']} → {trip['origin_iata']} "
                f"on {trip['end_date']}."
            )

        # Strip departure tokens (not needed for one-way display)
        for f in top3_out + top3_in:
            f.pop("_departure_token", None)

        return {
            "trip_type":    "one_way",
            "outbound_top3": top3_out,
            "inbound_top3":  top3_in,
            "return_best":   None,
            "currency":      currency,
        }

    # ── ROUND-TRIP (type == "1"): parallel return-flight searches ──
    base_params = build_flight_params(trip, flight_prefs)

    raw1  = await serpapi_mcp_call(base_params)
    data1 = parse_flight_result(raw1)
    top3  = _extract_top3(data1)

    if not top3:
        raise RuntimeError(
            f"No outbound flights found for "
            f"{trip['origin_iata']} → {trip['destination_iata']} "
            f"on {trip['start_date']}."
        )

    # Build return search tasks for all 3 outbound flights — run in parallel
    async def _fetch_return(idx: int, flight: dict) -> tuple[str, dict | None]:
        key       = f"for_outbound_{idx}"
        dep_token = flight.get("_departure_token", "")
        if not dep_token:
            return key, None
        return_params = {**base_params, "departure_token": dep_token}
        try:
            raw_ret  = await serpapi_mcp_call(return_params)
            data_ret = parse_flight_result(raw_ret)
            return key, _extract_best_return(data_ret)
        except Exception as e:
            return key, {"error": str(e)}

    results = await asyncio.gather(
        *[_fetch_return(idx, flight) for idx, flight in enumerate(top3[:3], start=1)]
    )
    return_best: dict[str, dict | None] = dict(results)

    for f in top3:
        f.pop("_departure_token", None)

    return {
        "trip_type":     "round_trip",
        "outbound_top3": top3,
        "return_best":   return_best,
        "currency":      currency,
    }


# Format flight results for LLM injection

def format_flights_for_llm(flight_data: dict) -> str:
    lines     = []
    trip_type = flight_data.get("trip_type", "")
    currency  = flight_data.get("currency", "")
    top3      = flight_data.get("outbound_top3", [])
    ret_best  = flight_data.get("return_best", {})

    # ── Outbound / one-way leg 1 ──
    direction = "OUTBOUND FLIGHTS" if trip_type == "round_trip" else "LEG 1 (OUTBOUND) FLIGHTS"
    lines.append(f"=== {direction} ===")

    for f in top3:
        lines.append(
            f"\n{f['rank']}. Price: {currency} {f['price']:,} | "
            f"{f['stops']} | Total: {f['total_duration_fmt']}"
        )
        for i, leg in enumerate(f["legs"], 1):
            ovn = " (overnight)" if leg["overnight"] else ""
            lines.append(f"   Leg {i}: {leg['flight_number']} | {leg['airline']} | {leg['airplane']}{ovn}")
            lines.append(f"     DEP: {leg['departure_airport']} @ {leg['departure_time']}")
            lines.append(f"     ARR: {leg['arrival_airport']} @ {leg['arrival_time']}")
            lines.append(f"     Duration: {leg['duration_fmt']} | Class: {leg['travel_class']}")
        for lv in f["layovers"]:
            lines.append(f"     Layover: {lv['airport']} ({lv['duration_fmt']})")

    # ── One-way: inbound leg ──
    if trip_type == "one_way":
        inbound_top3 = flight_data.get("inbound_top3", [])
        if inbound_top3:
            lines.append("\n=== LEG 2 (INBOUND) FLIGHTS ===")
            for f in inbound_top3:
                lines.append(
                    f"\n{f['rank']}. Price: {currency} {f['price']:,} | "
                    f"{f['stops']} | Total: {f['total_duration_fmt']}"
                )
                for i, leg in enumerate(f["legs"], 1):
                    ovn = " (overnight)" if leg["overnight"] else ""
                    lines.append(f"   Leg {i}: {leg['flight_number']} | {leg['airline']} | {leg['airplane']}{ovn}")
                    lines.append(f"     DEP: {leg['departure_airport']} @ {leg['departure_time']}")
                    lines.append(f"     ARR: {leg['arrival_airport']} @ {leg['arrival_time']}")
                    lines.append(f"     Duration: {leg['duration_fmt']} | Class: {leg['travel_class']}")
                for lv in f["layovers"]:
                    lines.append(f"     Layover: {lv['airport']} ({lv['duration_fmt']})")

    # ── Round-trip: return best ──
    if trip_type == "round_trip" and ret_best:
        lines.append("\n=== RETURN FLIGHTS (best per outbound option) ===")
        for key, rf in ret_best.items():
            idx = key.replace("for_outbound_", "")
            if not rf:
                lines.append(f"\nFor Outbound {idx}: No return flight found.")
                continue
            if "error" in rf:
                lines.append(f"\nFor Outbound {idx}: Error — {rf['error']}")
                continue
            lines.append(
                f"\nFor Outbound {idx} → Best Return: "
                f"{currency} {rf['price']:,} | {rf['stops']} | {rf['total_duration_fmt']}"
            )
            for i, leg in enumerate(rf["legs"], 1):
                ovn = " (overnight)" if leg["overnight"] else ""
                lines.append(f"   Leg {i}: {leg['flight_number']} | {leg['airline']}{ovn}")
                lines.append(f"     DEP: {leg['departure_airport']} @ {leg['departure_time']}")
                lines.append(f"     ARR: {leg['arrival_airport']} @ {leg['arrival_time']}")
                lines.append(f"     Duration: {leg['duration_fmt']}")
            for lv in rf["layovers"]:
                lines.append(f"     Layover: {lv['airport']} ({lv['duration_fmt']})")

    return "\n".join(lines)


# EXA DESTINATION RESEARCH

VALID_DIET_OPTIONS = {"Veg", "Non-veg"}

_STRUCTURING_SYSTEM_PROMPT = """
You are a travel research assistant.
You will receive raw web search highlights about a travel destination, split into three sections: PLACES TO VISIT, HOTELS, and FOOD & RESTAURANTS.
Summarize clearly using bullet points under these exact three sections:

📍 Best Places to Visit
🏨 Best Hotels
🍜 Must-Try Food & Restaurants

Rules:
* Use "•" as the bullet character.
* Each bullet: one line, max 20 words.
* List at least 10 bullets per section, or as many as the data allows.
* Never repeat the same entity with multiple descriptions.
* No preamble, no closing remarks — only the three sections with bullets.
""".strip()

_MAX_CHARS_PER_RESULT = 1500



# TravelPreferences

class TravelPreferences:
    def __init__(
        self,
        travel_style: str = "Balanced",
        budget: str = "Mid-range",
        interests: list[str] | None = None,
        hotel_preference: list[str] | None = None,
        diet: list[str] | str | None = None,
        food_preference: list[str] | None = None,
        special_requirements: list[str] | str = "Solo",
    ):
        if diet is None:
            raise ValueError("diet is required. Pass one or both of: 'Veg', 'Non-veg'.")
        if isinstance(diet, str):
            diet = [diet]

        diet_set = set(diet)
        invalid  = diet_set - VALID_DIET_OPTIONS
        if invalid:
            raise ValueError(f"Invalid diet value(s): {invalid}. Only 'Veg' and 'Non-veg' are allowed.")
        if len(diet) != len(diet_set):
            raise ValueError("diet contains duplicates.")

        if isinstance(special_requirements, str):
            special_requirements = [special_requirements]

        self.travel_style         = travel_style
        self.budget               = budget
        self.interests            = interests or ["Culture", "Nature"]
        self.hotel_preference     = hotel_preference or ["Hotel"]
        self.diet                 = sorted(diet_set)
        self.food_preference      = food_preference or ["Local"]
        self.special_requirements = special_requirements

    def diet_str(self) -> str:
        if set(self.diet) == {"Veg", "Non-veg"}:
            return "vegetarian and non-vegetarian"
        return "vegetarian" if self.diet == ["Veg"] else "non-vegetarian"

    def special_req_str(self) -> str:
        return ", ".join(self.special_requirements)

    def build_queries(self, destination: str) -> dict[str, str]:
        interests_str  = ", ".join(self.interests)
        hotel_pref_str = ", ".join(self.hotel_preference).lower()
        food_pref_str  = ", ".join(self.food_preference).lower()
        req_str        = self.special_req_str().lower()

        return {
            "places": (
                f"best places to visit in {destination} for {self.travel_style.lower()} "
                f"{req_str} traveler interested in {interests_str}"
            ),
            "hotels": (
                f"best {self.budget.lower()} {hotel_pref_str} hotels in {destination} "
                f"for {req_str} traveler"
            ),
            "food": (
                f"best {self.diet_str()} {food_pref_str} restaurants and food in {destination} "
                f"for {req_str} {self.budget.lower()} traveler"
            ),
        }


# TravelPreferences

def _extract_table_contents(text: str) -> str:
    lines, result_lines = text.splitlines(), []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            if all(c in "|-: " for c in stripped):
                continue
            cells = [c.strip() for c in stripped.split("|") if c.strip()]
            if cells:
                result_lines.append("  ".join(cells))
        else:
            result_lines.append(line)
    return "\n".join(result_lines)


def _clean_highlights(text: str) -> str:
    lines, clean_lines = text.splitlines(), []
    for line in lines:
        line = line.rstrip()
        while line.endswith("..."):
            line = line[:-3].rstrip()
        while line.startswith("..."):
            line = line[3:].lstrip()
        if line.strip():
            clean_lines.append(line)
    return "\n".join(clean_lines)


def _extract_highlights_and_urls(result: Any) -> tuple[list[str], list[str]]:
    highlights_list: list[str] = []
    urls: list[str] = []

    if not isinstance(result, list):
        return highlights_list, urls

    for block in result:
        if not (isinstance(block, dict) and block.get("type") == "text"):
            continue

        raw_text: str = block.get("text", "")
        entries = [e.strip() for e in raw_text.split("---") if e.strip()]

        for entry in entries:
            for line in entry.splitlines():
                if line.startswith("URL:"):
                    url = line.replace("URL:", "").strip()
                    if url:
                        urls.append(url)
                    break

            if "Highlights:" not in entry:
                continue

            highlights_raw = entry.split("Highlights:", 1)[1].strip()
            clean_lines = []
            for line in highlights_raw.splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("[") and "](" in stripped and stripped.endswith(")"):
                    continue
                if all(c in "-#" for c in stripped):
                    continue
                clean_lines.append(line)

            highlights_text = "\n".join(clean_lines).strip()
            highlights_text = _extract_table_contents(highlights_text)
            highlights_text = _clean_highlights(highlights_text)

            if highlights_text:
                highlights_list.append(highlights_text)

    return highlights_list, urls


def _trim_text(text: str, max_chars: int = _MAX_CHARS_PER_RESULT) -> str:
    if len(text) <= max_chars:
        return text
    trimmed     = text[:max_chars]
    last_period = trimmed.rfind(". ")
    if last_period > max_chars * 0.6:
        trimmed = trimmed[:last_period + 1]
    return trimmed + " [trimmed]"


def _build_combined_raw(all_results: dict[str, list[str]]) -> str:
    section_labels = {
        "places": "PLACES TO VISIT",
        "hotels": "HOTELS",
        "food":   "FOOD & RESTAURANTS",
    }
    combined = ""
    for key, highlights_list in all_results.items():
        combined += f"\n\n=== {section_labels.get(key, key.upper())} ===\n"
        for i, highlights in enumerate(highlights_list, 1):
            combined += f"\n-- Result {i} --\n{_trim_text(highlights)}\n"
    return combined



# Internal: single Exa category search

async def _search_exa_category(category: str, query: str) -> tuple[str, list[str], list[str]]:
    result           = await exa_search_tool.ainvoke({"query": query, "numResults": 5})
    highlights, urls = _extract_highlights_and_urls(result)
    return category, highlights, urls



# Internal: Groq structuring call

async def _structure_with_groq(
    destination: str,
    all_highlights: dict[str, list[str]],
    prefs: TravelPreferences,
) -> str | None:
    combined_raw = _build_combined_raw(all_highlights)
    if not combined_raw.strip():
        return None

    pref_context = (
        f"Traveler profile: {prefs.travel_style} style, {prefs.budget} budget, "
        f"{prefs.special_req_str()} traveler. "
        f"Interests: {', '.join(prefs.interests)}. "
        f"Hotel preference: {', '.join(prefs.hotel_preference)}. "
        f"Diet: {prefs.diet_str()}. "
        f"Food preference: {', '.join(prefs.food_preference)}."
    )

    messages = [
        SystemMessage(content=_STRUCTURING_SYSTEM_PROMPT),
        HumanMessage(content=(
            f"Destination: {destination}\n"
            f"{pref_context}\n\n"
            f"Raw search highlights:\n{combined_raw}"
        )),
    ]

    response = await groq_llm_extract_and_structure.ainvoke(messages)
    content  = response.content

    if isinstance(content, list):
        content = "\n".join(
            block["text"] for block in content
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text", "").strip()
        ).strip()
    else:
        content = content.strip()

    return content or None



# Public: Exa destination research

async def exa_destination_research(
    destination: str,
    travel_style: str = "Balanced",
    budget: str = "Mid-range",
    interests: list[str] | None = None,
    hotel_preference: list[str] | None = None,
    diet: list[str] | str | None = None,
    food_preference: list[str] | None = None,
    special_requirements: list[str] | str = "Solo",
) -> dict | None:
    """
    Research a destination via Exa MCP and structure results with Gemini.
    Returns { "output": str, "sources": dict[str, list[str]] } or None.
    """
    prefs = TravelPreferences(
        travel_style=travel_style,
        budget=budget,
        interests=interests,
        hotel_preference=hotel_preference,
        diet=diet,
        food_preference=food_preference,
        special_requirements=special_requirements,
    )

    await initialize_exa_tools()

    queries = prefs.build_queries(destination)
    tasks   = [_search_exa_category(cat, q) for cat, q in queries.items()]
    results = await asyncio.gather(*tasks)

    all_highlights: dict[str, list[str]] = {}
    all_urls: dict[str, list[str]]       = {}
    for category, highlights, urls in results:
        all_highlights[category] = highlights
        all_urls[category]       = urls

    output_text = await _structure_with_groq(destination, all_highlights, prefs)

    if output_text is None:
        return None

    return {
        "output":  output_text,
        "sources": all_urls,
    }


# Exa RAG Web Search (for RAG backend only)

async def exa_rag_search(query: str) -> dict:
    """
    Perform a single Exa web search for the RAG pipeline.
    Returns { "highlights": [str], "urls": [str] }
    Only highlights are passed to the LLM; URLs are used as artifact sources.
    """
    await initialize_exa_tools()

    try:
        result = await exa_search_tool.ainvoke({"query": query, "numResults": 2})
        highlights, urls = _extract_highlights_and_urls(result)

        # One entry per result, already pre-formatted for the LLM
        formatted_highlights = [
            f"---- Result {i} ----\n{h.strip()}"
            for i, h in enumerate(highlights, 1)
            if h.strip()
        ]

        return {
            "highlights": formatted_highlights,
            "urls": urls,
        }
    except Exception as e:
        print(f"[exa_rag_search] Error: {e}")
        return {"highlights": [], "urls": []}