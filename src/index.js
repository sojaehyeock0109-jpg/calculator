
const ALLOWED_ORIGIN =
  "https://sojaehyeock0109-jpg.github.io";

const MODEL = "gemini-3.6-flash";
const MAX_QUESTION_LENGTH = 1500;
const MAX_BODY_LENGTH = 5000;

function json(data, status = 200, cors = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      ...extraHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// Markdown 강조 표시만 제거하고 LaTeX 수식은 보존합니다.
function cleanFormatting(text) {
  return text
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/__(.*?)__/gs, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/Readable text and formulas used\?.*/gi, "")
    .replace(/Safety validation note included\?.*/gi, "")
    .replace(/Final Output Generation:.*/gi, "")
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

    if (origin !== ALLOWED_ORIGIN) {
      return json(
        { error: "허용되지 않은 요청 출처입니다." },
        403
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname !== "/api/solve") {
      return json(
        { error: "존재하지 않는 API 경로입니다." },
        404,
        cors
      );
    }

    if (request.method !== "POST") {
      return json(
        { error: "POST 요청만 지원합니다." },
        405,
        cors,
        { "Allow": "POST, OPTIONS" }
      );
    }

    // IP별 분당 요청 제한
    if (
      !env.AI_RATE_LIMITER ||
      typeof env.AI_RATE_LIMITER.limit !== "function"
    ) {
      return json(
        { error: "요청 제한 설정을 확인해 주세요." },
        503,
        cors
      );
    }

    const clientIp =
      request.headers.get("CF-Connecting-IP") || "unknown";

    try {
      const { success } = await env.AI_RATE_LIMITER.limit({
        key: `ai:${clientIp}`
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
      return json(
        { error: "요청 제한 기능을 확인할 수 없습니다." },
        503,
        cors
      );
    }

    const contentType =
      request.headers.get("Content-Type") || "";

    if (!contentType.toLowerCase().startsWith("application/json")) {
      return json(
        { error: "JSON 요청만 허용합니다." },
        415,
        cors
      );
    }

    const contentLength = Number(
      request.headers.get("Content-Length") || "0"
    );

    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_BODY_LENGTH
    ) {
      return json(
        { error: "요청 본문이 너무 큽니다." },
        413,
        cors
      );
    }

    let body;

    try {
      const rawBody = await request.text();

      if (rawBody.length > MAX_BODY_LENGTH) {
        return json(
          { error: "요청 본문은 5000자 이하여야 합니다." },
          413,
          cors
        );
      }

      body = JSON.parse(rawBody);
    } catch {
      return json(
        { error: "올바른 JSON 형식으로 요청해 주세요." },
        400,
        cors
      );
    }

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.question !== "string"
    ) {
      return json(
        { error: "질문은 문자열로 입력해 주세요." },
        400,
        cors
      );
    }

    const question = body.question.trim();

    if (!question || question.length > MAX_QUESTION_LENGTH) {
      return json(
        { error: "질문은 1~1500자로 입력해 주세요." },
        400,
        cors
      );
    }

    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(question)) {
      return json(
        { error: "허용되지 않는 제어 문자가 있습니다." },
        400,
        cors
      );
    }

    if (!env.GEMINI_API_KEY) {
      return json(
        { error: "Gemini API 키 설정을 확인해 주세요." },
        503,
        cors
      );
    }

    const systemPrompt = `
너는 간결하고 정확한 범용 공학 계산기다.

수학, 재료역학, 정역학, 동역학, 진동학, 열역학,
유체역학, 전기공학, 제어공학 등 공학 계산 문제를 처리한다.

답변은 다음 세 항목만 사용한다.

공식:
적용한 공식

대입:
주어진 숫자와 단위를 넣은 식

결과:
최종 계산 결과와 단위

출력 규칙:
- "공식:", "대입:", "결과:"라는 일반 텍스트 제목을 사용한다.
- ** 또는 __ 같은 Markdown 강조 기호를 사용하지 않는다.
- 인사말, 긴 설명, 요약, 추가 팁을 쓰지 않는다.
- 수식은 MathJax가 표시할 수 있는 LaTeX로 작성한다.
- LaTeX 수식의 달러 기호와 백슬래시를 임의로 제거하지 않는다.
- 문제에 필요한 값이 부족하면 결과를 추측하지 말고 필요한 값만 질문한다.
- 공식이 불확실하면 임의로 공식을 만들어 내지 않는다.
- 단위 변환과 계산 결과를 검토한다.
- 내부 점검 목록이나 자기 평가 문구를 출력하지 않는다.
- 지원 여부를 확신할 수 없는 문제는 솔직하게 알린다.
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
              maxOutputTokens: 450,
              thinkingConfig: {
                includeThoughts: false,
                thinkingLevel: "low"
              }
            }
          })
        }
      );

      if (!response.ok) {
        return json(
          {
            error: response.status === 429
              ? "AI 이용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요."
              : "AI 응답에 실패했습니다. 서버 설정과 API 이용 가능 여부를 확인해 주세요."
          },
          response.status === 429 ? 429 : 502,
          cors,
          response.status === 429 ? { "Retry-After": "60" } : {}
        );
      }

      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];

      const rawAnswer = parts
        .filter(part =>
          part &&
          !part.thought &&
          typeof part.text === "string"
        )
        .map(part => part.text)
        .join("\n")
        .trim();

      if (!rawAnswer) {
        return json(
          { error: "AI가 답변을 반환하지 않았습니다." },
          502,
          cors
        );
      }

      const answer = cleanFormatting(rawAnswer);

      if (!answer) {
        return json(
          { error: "표시할 답변이 없습니다. 다시 시도해 주세요." },
          502,
          cors
        );
      }

      return json({ answer }, 200, cors);

    } catch {
      return json(
        { error: "요청 처리 중 오류가 발생했습니다. 다시 시도해 주세요." },
        502,
        cors
      );
    }
  }
};
