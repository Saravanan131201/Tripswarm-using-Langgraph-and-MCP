"""
backend.py

Multi-agent travel planning workflow using LangGraph.
Agents: Flight Agent → Destination Research Agent → Itinerary Agent → Response Agent

"""

import asyncio
import os
from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import StateGraph, END

from llm_providers import groq_llm
from mcp_client import (
    search_flights_serpapi,
    format_flights_for_llm,
    exa_destination_research,
)


def _llm_call(system: str, user: str) -> str:
    try:
        resp = groq_llm.invoke([
            SystemMessage(content=system),
            HumanMessage(content=user),
        ])
        return resp.content
    except Exception as e:
        raise RuntimeError(f"LLM call failed: {e}")


# Socket.IO progress emitter (injected at runtime)

_sio = None          # set by app.py after socketio is created
_sid_map: dict = {}  # thread_id → socket sid


def set_socketio(sio):
    global _sio
    _sio = sio


def register_sid(thread_id: str, sid: str):
    _sid_map[thread_id] = sid


def unregister_sid(thread_id: str):
    _sid_map.pop(thread_id, None)


async def _emit_progress(sid: str | None, status: str, detail: str = ""):
    if _sio and sid:
        await _sio.emit(
            "agent_progress",
            {"status": status, "detail": detail},
            to=sid,
        )


# Travel State

class TravelState(TypedDict):
    user_query:           str
    trip_info:            dict
    flight_prefs:         dict
    travel_prefs:         dict
    flight_results:       str
    destination_research: str
    destination_sources:  dict
    itinerary:            str
    response:             str
    error:                str
    _sid:                 str   # socket sid for progress events


# Agent 1: Flight Agent

async def flight_agent(state: TravelState) -> TravelState:
    if state.get("error"):
        return state

    sid = state.get("_sid")
    await _emit_progress(sid, "searching_flights", "Searching for the best flights…")

    try:
        flight_data = await search_flights_serpapi(
            trip=state["trip_info"],
            flight_prefs=state["flight_prefs"],
        )
        formatted = format_flights_for_llm(flight_data)
        await _emit_progress(sid, "flights_found", "Flights found ✓")
        return {**state, "flight_results": formatted}

    except Exception as e:
        err_msg = f"✈️ Flight search failed: {str(e)}"
        await _emit_progress(sid, "agent_error", err_msg)
        return {**state, "error": err_msg}



# Agent 2: Destination Research Agent

async def destination_research_agent(state: TravelState) -> TravelState:
    if state.get("error"):
        return state

    sid = state.get("_sid")
    await _emit_progress(sid, "researching_destination", "Researching places, hotels & food…")

    try:
        trip  = state["trip_info"]
        prefs = state.get("travel_prefs", {})

        destination = (
            trip.get("destination_city") or
            trip.get("destination_iata", "Unknown")
        )

        result = await exa_destination_research(
            destination=destination,
            travel_style=prefs.get("travel_style", "Balanced"),
            budget=prefs.get("budget", "Mid-range"),
            interests=prefs.get("interests") or ["Culture", "Nature"],
            hotel_preference=prefs.get("hotel_preference") or ["Hotel"],
            diet=prefs.get("diet") or ["Veg", "Non-veg"],
            food_preference=prefs.get("food_preference") or ["Local"],
            special_requirements=prefs.get("special_requirements") or ["Solo"],
        )

        await _emit_progress(sid, "destination_found", "Destination research complete ✓")

        if result is None:
            return {**state, "destination_research": "", "destination_sources": {}}

        return {
            **state,
            "destination_research": result["output"],
            "destination_sources":  result["sources"],
        }

    except Exception as e:
        err_msg = f"🗺️ Destination research failed: {str(e)}"
        await _emit_progress(sid, "agent_error", err_msg)
        return {**state, "error": err_msg}



# Agent 3: Itinerary Agent

TRAVEL_STYLE_PROMPTS = {
    "Adventure": """
You are an expert adventure travel itinerary planner.

Prioritize outdoor activities, adventure experiences, exploration,
hiking, water sports, and active sightseeing where available.

Plan an activity-rich itinerary while considering physical effort,
travel time, activity duration, and safety.

Avoid unrealistic schedules and allow sufficient time for rest
between demanding activities.
""",

    "Relaxed": """
You are an expert relaxed travel itinerary planner.

Prioritize leisure, scenic experiences, comfortable sightseeing,
local food, beaches, cafés, and downtime.

Plan fewer major activities per day and leave generous free time.
Avoid rushing, tightly packed schedules, and unnecessary travel.

Make the trip comfortable and flexible.
""",

    "Balanced": """
You are an expert balanced travel itinerary planner.

Combine sightseeing, local experiences, outdoor activities,
food, and relaxation.

Plan a moderate number of activities per day, with a comfortable
pace and sufficient free time.

Avoid both overly packed and excessively empty schedules.
"""
}

async def itinerary_agent(state: TravelState) -> TravelState:
    if state.get("error"):
        return state

    sid = state.get("_sid")
    await _emit_progress(sid, "building_itinerary", "Building your day-by-day itinerary…")

    try:
        travel_style = (
            state.get("travel_prefs", {}).get("travel_style", "Balanced")
        )

        style_prompt = TRAVEL_STYLE_PROMPTS.get(
            travel_style,
            TRAVEL_STYLE_PROMPTS["Balanced"]
        )

        system = (
            f"{style_prompt}\n\n"
            "Create a practical, realistic, day-by-day itinerary using the destination research provided.\n\n"
            "Planning rules:\n"
            "- Group nearby attractions together where possible.\n"
            "- Consider travel time, opening hours and activity duration when this information is available.\n"
            "- Do not force exactly three activities into every day.\n"
            "- Use Morning, Afternoon, and Evening sections where appropriate.\n"
            "- Include specific places from the destination research.\n"
            "- Be concise — 350 words max. No markdown tables."
        )

        prompt = (
            f"Trip request: {state['user_query']}\n\n"
            f"Destination research (places, hotels, food):\n{state['destination_research']}\n\n"
            "Create a concise day-by-day itinerary referencing specific places and restaurants from the research."
        )

        itinerary = _llm_call(system, prompt)
        await _emit_progress(sid, "itinerary_done", "Itinerary ready ✓")
        return {**state, "itinerary": itinerary}

    except Exception as e:
        err_msg = f"📅 Itinerary planning failed: {str(e)}"
        await _emit_progress(sid, "agent_error", err_msg)
        return {**state, "error": err_msg}


# Agent 4: Final Response Agent

async def final_agent(state: TravelState) -> TravelState:
    if state.get("error"):
        return state

    sid = state.get("_sid")
    await _emit_progress(sid, "generating_report", "Generating your trip report…")

    try:
        trip   = state["trip_info"]
        prefs  = state["flight_prefs"]
        tprefs = state.get("travel_prefs", {})

        t_type        = "Round Trip" if prefs.get("type") == "1" else "One-way"
        adults        = prefs.get("adults", 1)
        children      = prefs.get("children", 0)
        infants_seat  = prefs.get("infants_in_seat", 0)
        infants_lap   = prefs.get("infants_on_lap", 0)
        t_cls         = {1: "Economy", 2: "Premium Economy", 3: "Business", 4: "First"}.get(
            int(prefs.get("travel_class", 1)), "Economy"
        )

        pax_parts = [f"{adults} adult{'s' if adults != 1 else ''}"]
        if children:     pax_parts.append(f"{children} child{'ren' if children != 1 else ''}")
        if infants_seat: pax_parts.append(f"{infants_seat} infant{'s' if infants_seat != 1 else ''} (seat)")
        if infants_lap:  pax_parts.append(f"{infants_lap} infant{'s' if infants_lap != 1 else ''} (lap)")
        pax_str = ", ".join(pax_parts)

        budget       = tprefs.get("budget", "Mid-range")
        travel_style = tprefs.get("travel_style", "Balanced")
        special_req  = ", ".join(tprefs.get("special_requirements") or ["Solo"])

        system = (
            "You are a professional AI travel assistant. "
            "Write a clean, structured travel report using the data provided.\n\n"
            "FORMATTING RULES — follow exactly:\n"
            "- DO NOT use markdown tables anywhere.\n"
            "- Use headings (## and ###), bullet points, and numbered lists only.\n"
            "- For flights: numbered items with airline, flight number, DEP, ARR, duration, stops, exact prices.\n"
            "- For places & hotels: bullet points per recommendation.\n"
            "- For food: bullet points per recommendation.\n"
            "- For itinerary: each day heading, then Morning / Midday / Evening bullets.\n"
            "- For budget: bullet points per category with estimated cost and short note.\n"
            "- Use **bold** for important highlights.\n"
            "- No filler sentences. Be practical and budget-aware.\n\n"
            "Use these exact sections:\n"
            "## 🗺️ Trip Summary\n"
            "## ✈️ Flight Options\n"
            "## 📍 Places to Visit\n"
            "## 🏨 Hotel Suggestions\n"
            "## 🍜 Food & Restaurants\n"
            "## 📅 Day-by-Day Itinerary\n"
            "## 💰 Estimated Budget\n"
            "## 💡 Final Recommendations"
        )

        prompt = (
            f"Trip Request: {state['user_query']}\n"
            f"Route: {trip['origin_iata']} → {trip['destination_iata']}\n"
            f"Dates: {trip['start_date']} → {trip['end_date']}\n"
            f"Type: {t_type} | Passengers: {pax_str} | Class: {t_cls}\n"
            f"Style: {travel_style} | Budget: {budget} | Travelers: {special_req}\n\n"
            f"✈️ FLIGHT DATA:\n{state['flight_results']}\n\n"
            f"🗺️ DESTINATION RESEARCH (places, hotels, food):\n{state['destination_research']}\n\n"
            f"📅 ITINERARY:\n{state['itinerary']}\n\n"
            "Write the complete TripSwarm travel report."
        )

        response = _llm_call(system, prompt)
        await _emit_progress(sid, "report_ready", "Trip report generated ✓")
        return {**state, "response": response}

    except Exception as e:
        err_msg = f"📝 Report generation failed: {str(e)}"
        await _emit_progress(sid, "agent_error", err_msg)
        return {**state, "error": err_msg}



# Error gate / routing

def _should_continue(state: TravelState) -> str:
    return "stop" if state.get("error") else "continue"



# Build LangGraph workflow

_graph = StateGraph(TravelState)

_graph.add_node("flight_agent",               flight_agent)
_graph.add_node("destination_research_agent", destination_research_agent)
_graph.add_node("itinerary_agent",            itinerary_agent)
_graph.add_node("final_agent",                final_agent)

_graph.set_entry_point("flight_agent")

_graph.add_conditional_edges(
    "flight_agent",
    _should_continue,
    {"continue": "destination_research_agent", "stop": END},
)
_graph.add_conditional_edges(
    "destination_research_agent",
    _should_continue,
    {"continue": "itinerary_agent", "stop": END},
)
_graph.add_conditional_edges(
    "itinerary_agent",
    _should_continue,
    {"continue": "final_agent", "stop": END},
)
_graph.add_edge("final_agent", END)

travel_app = _graph.compile()



# Public API

async def run_travel_workflow(
    message: str,
    trip_info: dict,
    flight_prefs: dict,
    travel_prefs: dict | None = None,
    sid: str | None = None,
) -> dict:
    initial_state = TravelState(
        user_query=message,
        trip_info=trip_info,
        flight_prefs=flight_prefs,
        travel_prefs=travel_prefs or {},
        flight_results="",
        destination_research="",
        destination_sources={},
        itinerary="",
        response="",
        error="",
        _sid=sid or "",
    )

    result = await travel_app.ainvoke(initial_state)

    if result.get("error"):
        return {"response": "", "error": result["error"]}

    return {
        "response":             result["response"],
        "error":                "",
        "flight_results_text":  result.get("flight_results", ""),
        "destination_sources":  result.get("destination_sources", {}),
    }