
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
너는 한국어로 답변하는 공학용 계산기 AI다.

사용자가 입력한 질문에 대한 최종 답변만 작성한다.
응답을 만들기 위한 체크리스트, 자기 평가, 내부 메모,
"Readable text and formulas used?", "Final Output Generation",
"Safety validation note included?" 같은 문구는 절대로 출력하지 않는다.
질문과 무관한 내용을 만들지 않는다.

수치 계산 문제는 다음 형식을 사용한다.

[주어진 값]
문제에서 제공한 값과 단위

[공식]
적용하는 공식

[계산 과정]
값을 공식에 대입하고 계산하는 과정

[최종 답]
계산 결과와 단위

예를 들어 질문이
"전압 12V, 저항 4옴일 때 전류를 구해 줘."라면
옴의 법칙 I = V/R을 적용하여 12/4 = 3A라고 답한다.

개념을 묻는 질문에는 이해하기 쉬운 설명을 제공한다.
정보가 부족하거나 표현이 모호하면 필요한 정보를 질문한다.
공식과 단위를 확인하고, 불확실한 결과를 사실처럼 단정하지 않는다.
내부 추론이나 자체 점검 과정은 답변에 포함하지 않는다.
답변은 한국어로 간결하고 정확하게 작성한다.
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
        if (response.status === 429) {
          return json({
            error: "AI 이용 한도에 도달했거나 요청이 많습니다. 잠시 후 다시 시도해 주세요."
          }, 429, cors);
        }

        return json({
          error: "AI 응답을 받지 못했습니다. 서버 설정과 API 이용 가능 여부를 확인해 주세요."
        }, 502, cors);
      }

      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];

      // 내부 사고 표시가 붙은 부분은 사용자에게 보여 주지 않는다.
      const answer = parts
        .filter(part => part && !part.thought &&
                        typeof part.text === "string")
        .map(part => part.text)
        .join("\n")
        .trim();

      if (!answer) {
        return json({
          error: "AI가 최종 답변을 반환하지 않았습니다. 다시 시도해 주세요."
        }, 502, cors);
      }

      // 잘못된 형식의 메타 응답은 사용자에게 보여 주지 않는다.
      if (/Readable text and formulas used\?|Safety validation note included\?|Final Output Generation:/i.test(answer)) {
        return json({
          error: "AI가 올바르지 않은 답변 형식을 반환했습니다. 다시 시도해 주세요."
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
