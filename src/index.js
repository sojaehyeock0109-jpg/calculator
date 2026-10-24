
const ALLOWED_ORIGIN = "https://sojaehyeock0109-jpg.github.io";
const MODEL = "gemini-3.6-flash";

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// 혹시 AI가 LaTeX를 반환하더라도 읽기 쉬운 문자로 바꿉니다.
function cleanAnswer(text) {
  return text
    .replace(/\$\$/g, "")
    .replace(/\$/g, "")
    .replace(/\\\(/g, "")
    .replace(/\\\)/g, "")
    .replace(/\\\[/g, "")
    .replace(/\\\]/g, "")
    .replace(/\\text\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1) / ($2)")
    .replace(/\\times|\\cdot/g, "×")
    .replace(/\\Omega/g, "Ω")
    .replace(/\\approx/g, "≈")
    .replace(/\\,/g, " ")
    .replace(/\\left|\\right/g, "")
    .trim();
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

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (origin !== ALLOWED_ORIGIN) {
      return json({ error: "허용되지 않은 요청 출처입니다." }, 403);
    }

    if (url.pathname !== "/api/solve") {
      return json({ error: "존재하지 않는 API 경로입니다." }, 404, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "POST 요청만 지원합니다." }, 405, cors);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "서버의 AI 키 설정을 확인해 주세요." }, 500, cors);
    }

    try {
      const body = await request.json();
      const question = typeof body.question === "string"
        ? body.question.trim()
        : "";

      if (!question || question.length > 1500) {
        return json({
          error: "질문을 입력해 주세요. 최대 1500자까지 가능합니다."
        }, 400, cors);
      }

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
              parts: [{
                text: `
너는 한국어 공학 계산기 AI다.

사용자 질문에 직접 답하고, 공학 문제는 다음 순서로 설명한다.
1. 주어진 값
2. 적용 공식
3. 값 대입과 계산 과정
4. 최종 답과 단위

중요한 출력 규칙:
- 모든 수식은 일반 텍스트로 작성한다.
- LaTeX 문법을 절대 사용하지 않는다.
- 달러 기호 $, 백슬래시 \\, \\frac, \\text, \\mathrm 등을 출력하지 않는다.
- 분수는 (분자) / (분모) 형태로 작성한다.
- 제곱은 x^2 형태로 작성한다.
- 예를 들어 "I = V / R", "I = 12 / 4 = 3 A"라고 작성한다.
- 체크리스트, 내부 점검 문구, 자기 평가를 출력하지 않는다.
- 질문에 대한 실제 풀이만 한국어로 작성한다.
- 정보가 부족하면 필요한 내용을 질문한다.
- 계산은 정확히 검토하고 불확실한 값은 단정하지 않는다.
                `.trim()
              }]
            },
            contents: [{
              role: "user",
              parts: [{ text: question }]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 800,
              thinkingConfig: {
                includeThoughts: false,
                thinkingLevel: "low"
              }
            }
          })
        }
      );

      if (!response.ok) {
        return json({
          error: response.status === 429
            ? "AI 이용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요."
            : "AI 응답을 받지 못했습니다. API 설정을 확인해 주세요."
        }, response.status === 429 ? 429 : 502, cors);
      }

      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];

      const rawAnswer = parts
        .filter(part => part && !part.thought &&
          typeof part.text === "string")
        .map(part => part.text)
        .join("\n")
        .trim();

      if (!rawAnswer) {
        return json({
          error: "AI가 답변을 반환하지 않았습니다. 다시 시도해 주세요."
        }, 502, cors);
      }

      const answer = rawAnswer;

      if (/Readable text and formulas used\?|Safety validation note included\?|Final Output Generation:/i.test(answer)) {
        return json({
          error: "AI 답변 형식이 올바르지 않습니다. 다시 시도해 주세요."
        }, 502, cors);
      }

      return json({ answer }, 200, cors);

    } catch (error) {
      return json({
        error: "요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
      }, 500, cors);
    }
  }
};
