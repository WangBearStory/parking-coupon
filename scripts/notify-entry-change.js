const API_URL = "https://dev-sni-admin.eyevacs.com";
const LOGIN_ID = "alstn5632";
const LOGIN_PW = "mirero2816!";
const SITE_ID = "SBI_EYEVACS_0032";
const PAGE_URL = "https://wangbearstory.github.io/parking-coupon/change-entry.html";

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";

// 사용자별 차량 매핑
const CHANNEL_VEHICLES = [
  { channel: "U0ADA5TB3TQ", vehicle: "127조9937" },
];

async function apiRequest(method, path, token, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (token) opts.headers["Authorization"] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(API_URL + path, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

async function login() {
  const data = await apiRequest("POST", "/auth/token", null, { id: LOGIN_ID, password: LOGIN_PW });
  return data.access_token;
}

async function sendSlack(channel, text) {
  if (!SLACK_TOKEN) {
    console.log("SLACK_BOT_TOKEN 미설정 - 알림 생략");
    return;
  }
  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SLACK_TOKEN}`
      },
      body: JSON.stringify({ channel, text })
    });
    const data = await resp.json();
    if (!data.ok) console.log(`Slack 전송 실패 (${channel}): ${data.error}`);
    else console.log(`Slack 전송 성공 (${channel})`);
  } catch (e) {
    console.log(`Slack 전송 오류 (${channel}): ${e.message}`);
  }
}

async function main() {
  console.log("=== 입차시간 변경 알림 시작 ===");
  const token = await login();
  console.log("로그인 성공");

  for (const { channel, vehicle } of CHANNEL_VEHICLES) {
    const data = await apiRequest("GET",
      `/vehicle-accesses?siteId=${SITE_ID}&vehicle=${encodeURIComponent(vehicle)}&status=inParking`, token);
    const items = data.vehicleAccesses || [];

    if (!items.length) {
      console.log(`${vehicle}: 미입차 - 알림 생략`);
      continue;
    }

    const link = `${PAGE_URL}?vehicle=${encodeURIComponent(vehicle)}`;
    const msg = `[${vehicle}] 현재 시간으로 입차시간을 변경하시겠습니까?\n${link}`;
    await sendSlack(channel, msg);
    console.log(`${vehicle}: 알림 전송 완료`);
  }

  console.log("=== 완료 ===");
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });
