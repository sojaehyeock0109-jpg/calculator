
const ALLOWED_ORIGIN =
  "https://sojaehyeock0109-jpg.github.io";

const MODEL = "gemini-3.6-flash";
const MAX_QUESTION_LENGTH = 1500;
const MAX_BODY_LENGTH = 5000;

function json(data, status = 200, cors = {}, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      ...extra,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// 모델이 수식 구분자까지 출력했더라도 중첩되지 않도록 정리합니다.
function cleanLatex(value) {
  if (typeof value !== "string") return "";

  return value
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\$([^$]+)\$/g, "$1")
    .replace(/\\\[((?:.|\n)*?)\\\]/g, "$1")
    .replace(/\\\(((?:.|\n)*?)\\\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

// 각 수식 필드를 MathJax 표시용 블록으로 감쌉니다.
function formatAnswer(data) {
  if (data.needsMoreInfo) {
    return data.question ||
      "계산에 필요한 값을 추가로 입력해 주세요.";
  }

  const formula = cleanLatex(data.formula);
  const substitution = cleanLatex(data.substitution);
  const result = cleanLatex(data.result);

  if (!formula || !substitution || !result) {
    throw new Error("AI 답변에 공식, 대입식 또는 결과가 누락됐습니다.");
  }

  return [
    "공식:",
    "\\[",
    formula,
    "\\]",
    "",
    "대입:",
    "\\[",
    substitution,
    "\\]",
    "",
    "결과:",
    "\\[",
    result,
    "\\]"
  ].join("\n");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Engineering Calculator API is running.");
    }

    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    if (origin !== ALLOWED_ORIGIN) {
      return json({ error: "허용되지 않은 요청 출처입니다." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname !== "/api/solve") {
      return json({ error: "존재하지 않는 API 경로입니다." }, 404, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "POST 요청만 지원합니다." }, 405, cors);
    }

    // Cloudflare에서 설정한 IP별 요청 제한 유지
    if (!env.AI_RATE_LIMITER) {
      return json({ error: "요청 제한 설정을 확인해 주세요." }, 503, cors);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    try {
      const { success } = await env.AI_RATE_LIMITER.limit({
        key: `ai:${ip}`
      });

      if (!success) {
        return json(
          { error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
          429,
          cors,
          { "Retry-After": "60" }
        );
      }
    } catch {
      return json({ error: "요청 제한 기능을 확인할 수 없습니다." }, 503, cors);
    }

    const contentType = request.headers.get("Content-Type") || "";

    if (!contentType.toLowerCase().startsWith("application/json")) {
      return json({ error: "JSON 요청만 허용합니다." }, 415, cors);
    }

    const contentLength = Number(request.headers.get("Content-Length") || "0");

    if (contentLength > MAX_BODY_LENGTH) {
      return json({ error: "요청 본문이 너무 큽니다." }, 413, cors);
    }

    let body;

    try {
      const raw = await request.text();

      if (raw.length > MAX_BODY_LENGTH) {
        return json({ error: "요청 본문은 5000자 이하여야 합니다." }, 413, cors);
      }

      body = JSON.parse(raw);
    } catch {
      return json({ error: "올바른 JSON 요청이 아닙니다." }, 400, cors);
    }

    if (
      !body ||
      Array.isArray(body) ||
      typeof body.question !== "string"
    ) {
      return json({ error: "질문을 문자열로 입력해 주세요." }, 400, cors);
    }

    const question = body.question.trim();

    if (!question || question.length > MAX_QUESTION_LENGTH) {
      return json({ error: "질문은 1~1500자로 입력해 주세요." }, 400, cors);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "Gemini API 키 설정을 확인해 주세요." }, 503, cors);
    }

    const systemPrompt = `
너는 공학 계산기다. 질문에 필요한 공식과 계산 결과를 간결하게 제공한다.

지원 분야를 전기공학에 한정하지 않는다. 수학, 재료역학, 정역학,
동역학, 진동학, 열역학, 유체역학, 기계공학, 전기공학, 제어공학
등 다양한 공학 분야의 문제를 해석한다.

반드시 JSON 객체만 반환한다. 마크다운 코드 블록은 사용하지 않는다.

출력 형식:
{
  "needsMoreInfo": false,
  "question": "",
  "formula": "공식의 LaTeX 내용",
  "substitution": "숫자를 대입한 LaTeX 식",
  "result": "계산 결과와 단위의 LaTeX 식"
}

규칙:
1. formula, substitution, result에는 수식 내용만 넣는다.
2. 수식 필드 안에는 $, $$, \\(, \\), \\[, \\] 구분자를 넣지 않는다.
   서버가 해당 구분자를 자동으로 추가한다.
3. 각 수식은 유효한 LaTeX로 작성한다.
   예: I = \\frac{V}{R}
4. 공식, 숫자 대입, 최종 결과를 각각 분리한다.
5. 긴 설명, 인사말, 추가 팁, 자기 평가를 출력하지 않는다.
6. 답변은 간결하게 작성하고 적절한 단위를 포함한다.
7. 계산에 필요한 값이 부족하거나 질문이 모호하면
   needsMoreInfo를 true로 하고 question에 필요한 값만 짧게 묻는다.
   이 경우 formula, substitution, result는 빈 문자열로 반환한다.
8. 필요한 값을 추측하지 않는다. 적용 공식이 불확실하면 확인을 요청한다.
9. 제시된 값과 단위를 확인하고 계산 결과를 검토한다.
    `.trim();

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }]
            },
            contents: [{
              role: "user",
              parts: [{ text: question }]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 500,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  needsMoreInfo: { type: "BOOLEAN" },
                  question: { type: "STRING" },
                  formula: { type: "STRING" },
                  substitution: { type: "STRING" },
                  result: { type: "STRING" }
                },
                required: [
                  "needsMoreInfo",
                  "question",
                  "formula",
                  "substitution",
                  "result"
                ],
                propertyOrdering: [
                  "needsMoreInfo",
                  "question",
                  "formula",
                  "substitution",
                  "result"
                ]
              },
              thinkingConfig: {
                includeThoughts: false,
                thinkingLevel: "low"
              }
            })
          })
        }
      );

      if (!response.ok) {
        return json({
          error: response.status === 429
            ? "AI 이용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요."
            : "AI 응답에 실패했습니다. API 설정과 이용 가능 여부를 확인해 주세요."
        }, response.status === 429 ? 429 : 502, cors);
      }

      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];

      const rawAnswer = parts
        .filter(part =>
          part && !part.thought && typeof part.text === "string"
        )
        .map(part => part.text)
        .join("")
        .trim();

      if (!rawAnswer) {
        return json({ error: "AI가 답변을 반환하지 않았습니다." }, 502, cors);
      }

      let parsed;

      try {
        parsed = JSON.parse(rawAnswer);
      } catch {
        return json({ error: "AI의 답변 형식이 올바르지 않습니다." }, 502, cors);
      }

      if (typeof parsed.needsMoreInfo !== "boolean") {
        return json({ error: "AI 답변의 필수 항목이 누락됐습니다." }, 502, cors);
      }

      const answer = formatAnswer(parsed);
      return json({ answer }, 200, cors);

    } catch (error) {
      return json({
        error: error instanceof Error &&
          error.message.startsWith("AI 답변")
            ? error.message
            : "요청 처리 중 오류가 발생했습니다. 다시 시도해 주세요."
      }, 502, cors);
    }
  }
};
