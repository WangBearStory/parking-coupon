const API_URL = "https://dev-sni-admin.eyevacs.com";
const LOGIN_ID = "alstn5632";
const LOGIN_PW = "mirero2816!";
const SITE_ID = "SBI_EYEVACS_0032";
const PAGE_URL = "https://wangbearstory.github.io/parking-coupon/change-entry.html";

const OWNER_ID = "66a9c4f0c920064e4a47abc9";
const COUPON_KEY_2H = "6690e5b8ebc44ff5ad8a1713";

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";

// 사용자별 차량 매핑
const CHANNEL_VEHICLES = [
  { channel: "U0ADA5TB3TQ", vehicle: "127조9937" },
  { channel: "U0AE6FTUWQ0", vehicle: "16마1011" },
  { channel: "U0AE046CVLJ", vehicle: "328서3376" },
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

function toIso(dt) { return dt.toISOString().replace(/\.\d{3}Z$/, ".000Z"); }
function kstStr(dt) {
  return dt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

// 입차시간을 현재 시각 6~10분 전으로 랜덤 보정 (쿠폰 applyAt 과의 자연스러운 시간차 확보)
function pickEntryTime() {
  const offsetMs = (6 + Math.random() * 4) * 60 * 1000;
  return new Date(Date.now() - offsetMs);
}

async function getVehicleByStatus(token, vehicle, status) {
  const data = await apiRequest("GET",
    `/vehicle-accesses?siteId=${SITE_ID}&vehicle=${encodeURIComponent(vehicle)}&status=${status}`, token);
  const items = data.vehicleAccesses || [];
  return items.length ? items[0] : null;
}

async function patchEntryTime(token, va, nowIso) {
  const facility = va.entry.facility._id;
  await apiRequest("PATCH", `/vehicle-accesses/${va._id}`, token, {
    entry: { accessedAt: nowIso, facility }
  });
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
  let detail = await apiRequest("GET", `/vehicle-accesses/${va._id}`, token);
  if (detail.vehicleAccess) detail = detail.vehicleAccess;
  const existing = ((detail.payment || {}).discountCouponList || []).map(cp => cp._id);
  existing.push(couponId);
  await apiRequest("PATCH", `/vehicle-accesses/${va._id}`, token, {
    payment: { discountCouponList: existing }
  });
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

// 입차중인 차량의 입차시간을 자동 변경하고 2시간무료 쿠폰을 적용 (페이지의 onBoth 동작과 동일)
async function processVehicle(token, vehicle) {
  const va = await getVehicleByStatus(token, vehicle, "inParking");
  if (!va) return { status: "skip" };

  const newEntry = pickEntryTime();
  await patchEntryTime(token, va, toIso(newEntry));

  let couponMsg;
  if (hasFreeCoupon(va)) {
    couponMsg = "2시간무료 쿠폰은 이미 적용되어 있습니다.";
  } else {
    const { nextCoupon, count } = await getNextCoupon(token);
    if (!nextCoupon) {
      couponMsg = "2시간무료 쿠폰 잔여가 없어 시간만 변경했습니다.";
    } else {
      await applyCoupon(token, va, nextCoupon);
      couponMsg = `2시간무료 쿠폰이 적용되었습니다. (잔여 ${count - 1})`;
    }
  }

  return { status: "done", newEntry, couponMsg };
}

async function main() {
  console.log("=== 입차시간 자동 변경 + 쿠폰 적용 시작 ===");
  const token = await login();
  console.log("로그인 성공");

  for (const { channel, vehicle } of CHANNEL_VEHICLES) {
    try {
      const result = await processVehicle(token, vehicle);

      if (result.status === "skip") {
        console.log(`${vehicle}: 미입차 - 알림 생략`);
        continue;
      }

      const msg = `[${vehicle}] 입차시간이 ${kstStr(result.newEntry)}(으)로 변경되었습니다.\n${result.couponMsg}`;
      await sendSlack(channel, msg);
      console.log(`${vehicle}: 자동 처리 완료`);
    } catch (e) {
      console.log(`${vehicle}: 자동 처리 실패 - ${e.message}`);
      const link = `${PAGE_URL}?vehicle=${encodeURIComponent(vehicle)}`;
      const msg = `[${vehicle}] 입차시간 자동 변경에 실패했습니다. 아래에서 직접 변경해 주세요.\n${link}`;
      await sendSlack(channel, msg);
    }
  }

  console.log("=== 완료 ===");
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });
