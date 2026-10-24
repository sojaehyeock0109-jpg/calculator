
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    // 간단한 서버 상태 확인
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

    if (!env.GEMINI_API_KEY) {
      return json({ error: "서버의 AI 키 설정을 확인해 주세요." }, 500, cors);
    }

    try {
      const length = Number(request.headers.get("Content-Length") || 0);

      if (length > 5000) {
        return json({ error: "질문이 너무 깁니다." }, 413, cors);
      }

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
                text: [
                  "너는 한국어 공학 문제 풀이 도우미다.",
                  "전기, 전자, 기계 및 기초 수학 문제를 설명한다.",
                  "문제에 주어진 값과 구할 값을 구분한다.",
                  "적용 공식, 값 대입, 계산 결과와 단위를 단계별로 설명한다.",
                  "정보가 부족하거나 표현이 모호하면 임의로 가정하지 말고 질문한다.",
                  "계산이 불확실하면 정확하다고 주장하지 않는다.",
                  "답변은 읽기 쉬운 일반 텍스트와 수식으로 작성한다.",
                  "실제 안전 설계에 사용하기 전에는 결과를 검증해야 한다."
                ].join("\n")
              }]
            },
            contents: [{
              role: "user",
              parts: [{ text: question }]
            }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 900
            }
          })
        }
      );

      if (!response.ok) {
        // API 키나 내부 세부 정보는 사용자에게 노출하지 않습니다.
        return json({
          error: response.status === 429
            ? "AI 무료 이용 한도에 도달했거나 요청이 많습니다. 잠시 후 다시 시도해 주세요."
            : "AI 응답을 받지 못했습니다. API 설정과 이용 가능 여부를 확인해 주세요."
        }, 502, cors);
      }

      const data = await response.json();
      const answer = (data.candidates?.[0]?.content?.parts || [])
        .map(part => part.text || "")
        .join("\n")
        .trim();

      if (!answer) {
        return json({ error: "AI가 답변을 반환하지 않았습니다." }, 502, cors);
      }

      return json({ answer }, 200, cors);

    } catch (error) {
      return json({
        error: "요청을 처리하지 못했습니다. 입력 형식을 확인해 주세요."
      }, 500, cors);
    }
  }
};
