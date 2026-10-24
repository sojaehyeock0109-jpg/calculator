
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    // 서버 상태 확인
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Engineering Calculator API is running.", {
        headers: { "Cache-Control": "no-store" }
      });
    }

    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    // 브라우저에서 허용할 사이트 출처 확인
    if (origin !== ALLOWED_ORIGIN) {
      return json(
        { error: "허용되지 않은 요청 출처입니다." },
        403
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
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

    // Worker에 요청 제한 바인딩이 등록되어 있는지 확인
    if (
      !env.AI_RATE_LIMITER ||
      typeof env.AI_RATE_LIMITER.limit !== "function"
    ) {
      return json(
        { error: "요청 제한 설정이 없습니다. Worker 배포 설정을 확인해 주세요." },
        503,
        cors
      );
    }

    // IP별 요청 제한: 분당 최대 8회
    const clientIp =
      request.headers.get("CF-Connecting-IP") || "unknown";

    try {
      const { success } = await env.AI_RATE_LIMITER.limit({
        key: `ai:${clientIp}`
      });

      if (!success) {
        return json(
          {
            error:
              "요청이 너무 많습니다. 60초 후 다시 시도해 주세요."
          },
          429,
          cors,
          { "Retry-After": "60" }
        );
      }
    } catch (error) {
      // 제한 장치가 작동하지 않으면 AI 요청을 허용하지 않음
      return json(
        { error: "요청 제한 기능을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요." },
        503,
        cors
      );
    }

    // JSON만 허용
    const contentType =
      request.headers.get("Content-Type") || "";

    if (!contentType.toLowerCase().startsWith("application/json")) {
      return json(
        { error: "JSON 형식의 요청만 허용합니다." },
        415,
        cors
      );
    }

    // Content-Length 사전 검사
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

      // Content-Length가 없거나 부정확한 경우도 검사
      if (rawBody.length > MAX_BODY_LENGTH) {
        return json(
          { error: "요청 본문은 5000자 이하여야 합니다." },
          413,
          cors
        );
      }

      body = JSON.parse(rawBody);
    } catch (error) {
      return json(
        { error: "올바른 JSON 형식으로 요청해 주세요." },
        400,
        cors
      );
    }

    // 입력값 자료형과 길이 검증
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

    if (!question) {
      return json(
        { error: "질문을 입력해 주세요." },
        400,
        cors
      );
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      return json(
        { error: "질문은 최대 1500자까지 입력할 수 있습니다." },
        400,
        cors
      );
    }

    // 예상하지 못한 제어 문자 차단
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(question)) {
      return json(
        { error: "질문에 허용되지 않는 제어 문자가 있습니다." },
        400,
        cors
      );
    }

    // Gemini Secret 확인
    if (!env.GEMINI_API_KEY) {
      return json(
        { error: "Gemini API 키 설정을 확인해 주세요." },
        503,
        cors
      );
    }

    const systemPrompt = `
너는 한국어 공학 계산기다.

사용자가 요구한 공학 계산의 공식, 값 대입, 최종 결과만
간결하게 제공한다.

답변 규칙:
1. 필요한 공식과 주어진 값을 확인한다.
2. 값이 충분하면 공식을 선택해 숫자를 대입한다.
3. 계산 결과와 단위를 표시한다.
4. 답변은 다음 세 항목으로 제한한다.

**공식**
적용 공식

**대입**
숫자를 넣은 수식

**결과**
최종 결과와 단위

5. 긴 설명, 인사말, 추가 팁, 자체 점검 문구는 출력하지 않는다.
6. 수식은 MathJax가 표시할 수 있는 LaTeX로 작성한다.
7. 필요한 값이 없거나 질문이 모호하면 추측하지 말고
   필요한 값만 짧게 질문한다.
8. 단위 변환과 계산 과정을 확인하고 결과를 검증한다.
9. 공식을 확신할 수 없으면 임의로 만들어 내지 않는다.
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
              maxOutputTokens: 350,
              thinkingConfig: {
                includeThoughts: false,
                thinkingLevel: "low"
              }
            }
          })
        }
      );

      if (!response.ok) {
        if (response.status === 429) {
          return json(
            { error: "AI 이용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요." },
            429,
            cors,
            { "Retry-After": "60" }
          );
        }

        return json(
          { error: "AI 응답을 받지 못했습니다. API 설정이나 이용 한도를 확인해 주세요." },
          502,
          cors
        );
      }

      const data = await response.json();

      const parts =
        data.candidates?.[0]?.content?.parts || [];

      const answer = parts
        .filter(part =>
          part &&
          !part.thought &&
          typeof part.text === "string"
        )
        .map(part => part.text)
        .join("\n")
        .trim();

      if (!answer) {
        return json(
          { error: "AI가 결과를 반환하지 않았습니다. 다시 시도해 주세요." },
          502,
          cors
        );
      }

      // 내부 점검 목록 등이 답변에 섞여 나오는 경우 차단
      if (
        /Readable text and formulas used\?|Safety validation note included\?|Final Output Generation:/i.test(answer)
      ) {
        return json(
          { error: "AI 답변 형식이 올바르지 않습니다. 다시 시도해 주세요." },
          502,
          cors
        );
      }

      return json({ answer }, 200, cors);

    } catch (error) {
      return json(
        { error: "요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." },
        502,
        cors
      );
    }
  }
};
