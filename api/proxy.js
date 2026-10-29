export const handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const apiKey = process.env.META_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "META_API_KEY not set" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    let metaInput = null;
    let model = body.model || process.env.META_MODEL || "muse-spark-open-1026";
    
    if (model === "muse-spark-open-1026" || model === "muse-spark") model = "muse-wonder-1.0";

    if (body.input && Array.isArray(body.input)) {
      metaInput = body.input;
    } else {
      let systemText = "", userText = "", imageUrl = null;
      if (body.messages && Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (m.role === "system") systemText = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          else if (m.role === "user") {
            if (typeof m.content === "string") userText = m.content;
            else if (Array.isArray(m.content)) {
              for (const part of m.content) {
                if (part.type === "text" && part.text) userText += (userText ? "\n" : "") + part.text;
                if (part.type === "image_url" && part.image_url?.url) imageUrl = part.image_url.url;
              }
            }
          }
        }
      }
      if (body.imageBase64) imageUrl = body.imageBase64;
      let combined = systemText ? systemText + "\n\n" : "";
      combined += userText || "Hello";

      const contentArray = [{ type: "input_text", text: combined }];
      if (imageUrl) contentArray.push({ type: "input_image", image_url: imageUrl });
      metaInput = [{ role: "user", content: contentArray }];
    }

    const upstream = await fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: metaInput, reasoning: body.reasoning || { effort: "low" }, stream: false }),
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return { statusCode: upstream.status, headers, body: JSON.stringify({ error: "AI unavailable", details: data }) };

    let extracted = null;
    try {
      const msg = data.output?.find((x) => x.type === "message");
      extracted = msg?.content?.[0]?.text || msg?.content?.[0]?.input_text || null;
    } catch {}

    if (extracted) {
      return { statusCode: 200, headers, body: JSON.stringify({ ...data, choices: [{ message: { content: extracted } }] }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Proxy failed", details: String(err.message) }) };
  }
};
