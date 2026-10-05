"""
tools/flight_tool.py

Groq-powered natural-language trip extractor.
"""

import json
import re
from datetime import date, timedelta

from langchain_core.messages import SystemMessage, HumanMessage

from llm_providers import groq_llm_extract_and_structure

# AFTER — replace with this:
_TODAY = date.today().isoformat()

_SYSTEM_TEMPLATE = """
You are a travel query parser. Today's date is {today}.

The user's home country is: {user_country}
Use this as the origin city/country ONLY if the user has NOT mentioned a origin city or country in their query.
Map the home country to its main international airport IATA code (e.g. "India" → "DEL" or infer from context like "Chennai" → "MAA").

Extract the following fields from the user's query and return ONLY a valid JSON object — no markdown, no explanation, no extra text.

Fields to extract:
{{
  "origin_city":            string | null,
  "destination_city":       string | null,
  "origin_iata":            string | null,
  "destination_iata":       string | null,
  "start_date":             string | null,
  "end_date":               string | null,
  "trip_type":              "1" | "2",
  "travel_class":           1 | 2 | 3 | 4,
  "adults":                 int,
  "children":               int,
  "infants_in_seat":        int,
  "infants_on_lap":         int,
  "travel_style":           "Adventure" | "Relaxed" | "Balanced" | null,
  "budget":                 "Budget" | "Mid-range" | "Luxury" | null,
  "interests":              string[] | null,
  "hotel_preference":       string[] | null,
  "diet":                   string[] | null,
  "food_preference":        string[] | null,
  "special_requirements":   string[] | null
}}

Rules:
- Infer IATA codes from city/airport names. Use the most common international airport for each city.
- If the user says "from X to Y", X=origin, Y=destination.
- If the user does NOT mention an origin/departure city, use the user's home country to determine origin_city and origin_iata.
- Always populate origin_city and destination_city as the full city name. If a country is given, infer the capital/main city.
- For relative dates: "next week" = 7 days from today, "next month" = 30 days, "in 3 days" = 3 days from today.
- If only a duration is given (e.g. "5 days"), set start_date=null, end_date=null.
- If only start_date is inferable, set end_date=null.
- For budget: "cheap"/"budget"/"affordable" → "Budget"; "moderate"/"mid" → "Mid-range"; "luxury"/"premium" → "Luxury".
- For travel_style: "adventure"/"hiking" → "Adventure"; "relax"/"beach"/"resort" → "Relaxed"; default → "Balanced".
- For special_requirements: "honeymoon"/"couple" → ["Couple"]; "family"/"kids" → ["Family","Kids"]; "solo" → ["Solo"].
- Always return valid JSON. Null for any field you cannot confidently determine.
""".strip()


def extract_trip_request(query: str, user_country: str = "India") -> dict:
    """
    Parse a natural-language travel query using Groq.
    user_country: the user's home country stored in their profile (used as origin fallback).
    """
    system_prompt = _SYSTEM_TEMPLATE.format(
        today=_TODAY,
        user_country=user_country or "India",
    )
    try:
        response = groq_llm_extract_and_structure.invoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=query),
        ])

        raw = response.content
        if isinstance(raw, list):
            raw = " ".join(b.get("text", "") for b in raw if isinstance(b, dict) and b.get("type") == "text")

        raw = raw.strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)

        parsed = json.loads(raw.strip())

        parsed.setdefault("adults", 1)
        parsed.setdefault("children", 0)
        parsed.setdefault("infants_in_seat", 0)
        parsed.setdefault("infants_on_lap", 0)
        parsed.setdefault("trip_type", "1")
        parsed.setdefault("travel_class", 1)

        start = parsed.get("start_date")
        end   = parsed.get("end_date")
        today = date.today()

        if start:
            try:
                s = date.fromisoformat(start)
                if s < today:
                    parsed["start_date"] = None
                    parsed["end_date"]   = None
            except ValueError:
                parsed["start_date"] = None
                parsed["end_date"]   = None

        if end and parsed.get("start_date"):
            try:
                s = date.fromisoformat(parsed["start_date"])
                e = date.fromisoformat(end)
                if e <= s:
                    parsed["end_date"] = None
            except ValueError:
                parsed["end_date"] = None

        has_route = bool(parsed.get("origin_iata") and parsed.get("destination_iata"))
        has_dates = bool(parsed.get("start_date") and parsed.get("end_date"))

        parsed["valid"] = has_route and has_dates
        parsed["error"] = "" if parsed["valid"] else (
            "Missing route." if not has_route else
            "Missing or invalid dates." if not has_dates else ""
        )

        return parsed

    except json.JSONDecodeError as e:
        return {
            "valid": False, "error": f"Parse error: {e}",
            "origin_iata": None, "destination_iata": None,
            "start_date": None, "end_date": None,
        }
    except Exception as e:
        return {
            "valid": False, "error": str(e),
            "origin_iata": None, "destination_iata": None,
            "start_date": None, "end_date": None,
        }