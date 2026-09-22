const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 天免登录

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const passwordEnv = env.PASSWORD;
  const url = new URL(request.url);

  const body = await request.json().catch(() => ({ password: "" }));
  const providedPassword = typeof body.password === "string" ? body.password : "";

  // 未设置 PASSWORD 时直接放行（完全符合官方原版行为）
  if (typeof passwordEnv !== "string" || !passwordEnv) {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // 严格比对访问口令
  if (providedPassword === passwordEnv) {
    const cookieSegments = [
      `auth=${btoa(passwordEnv)}`,
      `Max-Age=${MAX_AGE_SECONDS}`,
      "Path=/",
      "SameSite=Lax",
      "HttpOnly",
    ];
    if (url.protocol === "https:") {
      cookieSegments.push("Secure");
    }

    return new Response(JSON.stringify({ success: true, message: "登录成功" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": cookieSegments.join("; "),
      },
    });
  }

  return new Response(JSON.stringify({ success: false, error: "口令错误，请重试" }), {
    status: 401,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
