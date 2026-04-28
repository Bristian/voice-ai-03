"""Response synthesis — GPT-4o voice-first output.

Takes RAG chunks + vehicle results + conversation history and produces
a voice-natural response. Max ~50 words. No markdown, no lists, no URLs.
Always ends with a follow-up question.
"""

from __future__ import annotations

import logging
import time

from openai import AsyncOpenAI

from app.config import Settings

logger = logging.getLogger("agent-api.synthesis")

_client: AsyncOpenAI | None = None
_settings: Settings | None = None

SYSTEM_PROMPT = """\
You are a car dealership sales assistant on the phone. Be warm but CONCISE.

STRICT RULES:
1. Respond in 1-2 sentences MAXIMUM. Stay under 40 words.
2. NO markdown, bullets, lists, URLs, or special formatting.
3. NO preambles like "Great question!" or "Here's what I found".
4. Speak naturally with contractions — "we've got" not "we have".
5. Mention at most 2 vehicles per response. Say year, make, model, and price.
6. Say prices naturally: "around thirty-three thousand" not "$33,000".
7. End with ONE short follow-up question.
8. If the matching vehicles don't exactly match what was asked (e.g., they asked for manual but results are all automatic), acknowledge that honestly and suggest the closest alternatives from the results.
9. If there are NO vehicles or context at all, offer to help find something else or suggest they speak with a team member.
10. NEVER make up vehicles, prices, or policies not in the context.
"""


def init_synthesis(settings: Settings) -> None:
    global _client, _settings
    _client = AsyncOpenAI(api_key=settings.openai_api_key)
    _settings = settings


async def synthesize_response(
    transcript: str,
    intent: str,
    rag_chunks: list[dict] | None = None,
    vehicles: list[dict] | None = None,
    conversation_history: list[dict] | None = None,
) -> str:
    """Generate a voice-first response using GPT-4o.

    Returns the response text (ready for TTS).
    """
    assert _client is not None and _settings is not None

    # Build context block
    context_parts: list[str] = []

    if rag_chunks:
        chunk_texts = [c.get("content", "") for c in rag_chunks[:3]]
        context_parts.append("KNOWLEDGE BASE CONTEXT:\n" + "\n---\n".join(chunk_texts))

    if vehicles:
        v_summaries = []
        for v in vehicles[:3]:
            features_str = ", ".join(v.get("features", [])[:3]) if v.get("features") else ""
            v_summaries.append(
                f"- {v['year']} {v['make']} {v['model']} {v.get('trim', '')} "
                f"in {v.get('color_ext', 'unknown color')}, "
                f"${v['price']:,.0f}, {v.get('mileage', 0):,} miles"
                f"{', ' + features_str if features_str else ''}"
            )
        context_parts.append("MATCHING VEHICLES:\n" + "\n".join(v_summaries))

    if not context_parts:
        context_parts.append("No specific context available. Offer general help or suggest transferring to a human.")

    # Build conversation history (last 6 turns)
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    if conversation_history:
        for turn in conversation_history[-6:]:
            role = turn.get("role", "user")
            messages.append({"role": role, "content": turn.get("text", "")})

    user_content = (
        f"Caller said: \"{transcript}\"\n"
        f"Detected intent: {intent}\n\n"
        + "\n\n".join(context_parts)
    )
    messages.append({"role": "user", "content": user_content})

    t0 = time.monotonic()
    resp = await _client.chat.completions.create(
        model=_settings.synthesis_model,
        messages=messages,
        temperature=0.7,
        max_tokens=100,  # Voice responses must be short
    )
    elapsed_ms = (time.monotonic() - t0) * 1000

    text = resp.choices[0].message.content or "I'm sorry, let me transfer you to someone who can help."
    logger.info("Synthesis in %.0fms (%d chars): %s", elapsed_ms, len(text), text[:100])

    return text
