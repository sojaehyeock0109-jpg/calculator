
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

      const systemPrompt = `
너는 긴 설명을 하지 않는 한국어 공학 계산기다.
목표는 사용자가 원하는 공학 계산의 공식, 값 대입, 최종 결과만 제공하는 것이다.

규칙:
1. 사용자의 질문에서 구할 물리량과 주어진 수치를 확인한다.
2. 문제에 적합한 표준 수학·공학 공식을 선택한다.
3. 필요한 값이 충분하면 공식에 실제 숫자와 단위를 대입해 계산한다.
4. 답변은 반드시 다음 세 항목만 사용한다.

**공식**
적용할 공식

**대입**
숫자와 단위를 넣은 식

**결과**
계산 결과와 단위

5. 인사말, 긴 개념 설명, 공식 유도, 요약, 추가 팁은 쓰지 않는다.
6. 공식과 수식은 MathJax가 표시할 수 있는 LaTeX로 작성한다.
   예: \\( I = \\frac{V}{R} \\)
7. 계산 결과는 적절한 유효숫자로 표시하고 단위를 반드시 포함한다.
8. 단위 변환이 필요하면 올바르게 변환한 뒤 대입한다.
9. 필요한 수치가 빠졌거나 질문이 모호하면 결과를 추측하지 않는다.
   대신 계산에 필요한 값만 한 문장으로 질문한다.
10. 적용할 공식이 불확실하면 임의로 공식을 만들지 말고 사용자에게 확인한다.
11. 내부 점검 목록이나 자기 평가 문구는 절대 출력하지 않는다.

예시 질문:
전압 12V, 저항 4옴일 때 전류를 구해 줘.

예시 답변:
**공식**
\\( I = \\frac{V}{R} \\)

**대입**
\\( I = \\frac{12\\,\\mathrm{V}}{4\\,\\Omega} \\)

**결과**
\\( I = 3\\,\\mathrm{A} \\)
      `.trim();

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
        return json({
          error: response.status === 429
            ? "AI 이용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요."
            : "AI 응답에 실패했습니다. 서버와 API 설정을 확인해 주세요."
        }, response.status === 429 ? 429 : 502, cors);
      }

      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];

      const answer = parts
        .filter(part =>
          part && !part.thought && typeof part.text === "string"
        )
        .map(part => part.text)
        .join("\n")
        .trim();

      if (!answer) {
        return json({
          error: "계산 결과를 받지 못했습니다. 다시 시도해 주세요."
        }, 502, cors);
      }

      if (/Readable text and formulas used\?|Safety validation note included\?|Final Output Generation:/i.test(answer)) {
        return json({
          error: "올바르지 않은 답변이 반환됐습니다. 다시 시도해 주세요."
        }, 502, cors);
      }

      return json({ answer }, 200, cors);

    } catch (error) {
      return json({
        error: "요청 처리 중 오류가 발생했습니다. 다시 시도해 주세요."
      }, 500, cors);
    }
  }
};
