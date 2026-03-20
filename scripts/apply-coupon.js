const API_URL = "https://dev-sni-admin.eyevacs.com";
const LOGIN_ID = "alstn5632";
const LOGIN_PW = "mirero2816!";
const SITE_ID = "SBI_EYEVACS_0032";
const OWNER_ID = "66a9c4f0c920064e4a47abc9";
const COUPON_KEY_2H = "6690e5b8ebc44ff5ad8a1713";
const VEHICLES = ["16마1011", "127조9937", "328서3376"];

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

async function main() {
  console.log("=== 쿠폰 자동 적용 시작 ===");
  const token = await login();
  console.log("로그인 성공");

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
  }

  console.log("=== 완료 ===");
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });
