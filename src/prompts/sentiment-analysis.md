Analyze the sentiment and emotional posture of this investor based on the text below.

Return a structured assessment covering:

- **overall**: One of "positive", "neutral", "negative", "mixed"
- **confidence**: How self-assured they sound — one of "high", "medium", "low"
- **riskAppetite**: Their attitude toward risk — one of "aggressive", "moderate", "conservative"
- **founderEmpathy**: How empathetic they appear toward founders — one of "high", "medium", "low"
- **keySignals**: Array of short phrases (max 5) quoting specific language that reveals their attitude

Be concrete. Do not guess. Only score what the text supports. Return raw JSON only — no markdown, no preamble. Use this exact shape:
{"overall":"positive|neutral|negative|mixed","confidence":"high|medium|low","riskAppetite":"aggressive|moderate|conservative","founderEmpathy":"high|medium|low","keySignals":["..."]}

---

{{text}}
