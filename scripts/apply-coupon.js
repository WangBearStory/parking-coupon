const API_URL = "https://dev-sni-admin.eyevacs.com";
const LOGIN_ID = "alstn5632";
const LOGIN_PW = "mirero2816!";
const SITE_ID = "SBI_EYEVACS_0032";
const OWNER_ID = "66a9c4f0c920064e4a47abc9";
const COUPON_KEY_2H = "6690e5b8ebc44ff5ad8a1713";
const VEHICLES = ["16마1011", "127조9937", "328서3376"];

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNELS = ["D0ADWM544F7", "D0AD5RJ7JFM", "D0ADC7GSNM8"];

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

async function getVehicle(token, vehicle) {
  const data = await apiRequest("GET",
    `/vehicle-accesses?siteId=${SITE_ID}&vehicle=${encodeURIComponent(vehicle)}&status=inParking`, token);
  const items = data.vehicleAccesses || [];
  return items.length ? items[0] : null;
}

function hasFreeCoupon(va) {
  const coupons = (va.payment || {}).discountCouponList || [];
  return coupons.some(cp => {
    const key = cp.discountCouponKey || {};
    return typeof key === "object" && (key.name || "").includes("방문자확인");
  });
}

async function getNextCoupon(token) {
  const data = await apiRequest("GET",
    `/discount-coupon-keys/coupon?owner=${OWNER_ID}&ownerModel=Admin`, token);
  for (const key of (data.discountCouponKeys || [])) {
    if (key._id === COUPON_KEY_2H) return { nextCoupon: key.nextCoupon, count: key.count || 0 };
  }
  return { nextCoupon: null, count: 0 };
}

async function applyCoupon(token, va, couponId) {
  const vaId = va._id;
  let detail = await apiRequest("GET", `/vehicle-accesses/${vaId}`, token);
  if (detail.vehicleAccess) detail = detail.vehicleAccess;
  const existing = ((detail.payment || {}).discountCouponList || []).map(cp => cp._id);
  existing.push(couponId);
  await apiRequest("PATCH", `/vehicle-accesses/${vaId}`, token, {
    payment: { discountCouponList: existing }
  });
}

async function sendSlack(message) {
  if (!SLACK_TOKEN) {
    console.log("SLACK_BOT_TOKEN 미설정 - 알림 생략");
    return;
  }
  for (const channel of SLACK_CHANNELS) {
    try {
      const resp = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SLACK_TOKEN}`
        },
        body: JSON.stringify({ channel, text: message })
      });
      const data = await resp.json();
      if (!data.ok) console.log(`Slack 전송 실패 (${channel}): ${data.error}`);
    } catch (e) {
      console.log(`Slack 전송 오류 (${channel}): ${e.message}`);
    }
  }
}

async function main() {
  console.log("=== 쿠폰 자동 적용 시작 ===");
  const token = await login();
  console.log("로그인 성공");

  const applied = [];

  for (const vehicle of VEHICLES) {
    const va = await getVehicle(token, vehicle);
    if (!va) {
      console.log(`${vehicle}: 미입차 - 스킵`);
      continue;
    }
    if (hasFreeCoupon(va)) {
      console.log(`${vehicle}: 쿠폰 이미 적용됨 - 스킵`);
      continue;
    }
    const { nextCoupon, count } = await getNextCoupon(token);
    if (!nextCoupon) {
      console.log(`${vehicle}: 2시간무료 쿠폰 없음 (잔여: ${count})`);
      continue;
    }
    await applyCoupon(token, va, nextCoupon);
    console.log(`${vehicle}: 2시간무료 쿠폰 적용 완료 (잔여: ${count - 1})`);
    applied.push(`${vehicle} (잔여: ${count - 1})`);
  }

  if (applied.length > 0) {
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const msg = `[주차 쿠폰 자동 적용] ${now}\n2시간무료 쿠폰 적용 완료:\n${applied.map(v => `- ${v}`).join("\n")}`;
    await sendSlack(msg);
  }

  console.log("=== 완료 ===");
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });
