const AGENT_API_URL = process.env.NEXT_PUBLIC_AGENT_API_URL || "http://localhost:8000";

export async function fetchSessions(limit = 20, offset = 0) {
  const res = await fetch(`${AGENT_API_URL}/v1/sessions?limit=${limit}&offset=${offset}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return res.json();
}

export async function fetchSession(callUuid) {
  const res = await fetch(`${AGENT_API_URL}/v1/sessions/${callUuid}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`);
  return res.json();
}
