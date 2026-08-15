// 前端逻辑

// 前端校验：提取 tid（纯数字或 tieba 链接）
function extractTid(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/tieba\.baidu\.com\/p\/(\d+)/i);
  return m ? m[1] : null;
}

// ===== 用户许可协议弹窗 =====
const overlay = document.getElementById("agreement-overlay");
const agreementText = document.getElementById("agreement-text");
const agreementConfirm = document.getElementById("agreement-confirm");
const agreementHint = document.getElementById("agreement-hint");
const countdownEl = document.getElementById("agreement-countdown");

const WAIT_SECONDS = 5;
let reachedBottom = false;
let secondsLeft = WAIT_SECONDS;

function updateAgreementState() {
  agreementConfirm.disabled = !(reachedBottom && secondsLeft <= 0);
}

function renderHint() {
  if (!reachedBottom) {
    agreementHint.innerHTML = `请将协议阅读到底部，并等待 <span class="countdown">${secondsLeft}</span> 秒`;
  } else if (secondsLeft > 0) {
    agreementHint.innerHTML = `已阅读到底部，请等待 <span class="countdown">${secondsLeft}</span> 秒`;
  } else {
    agreementHint.textContent = "点击下方确认按钮即视为已完整理解并同意上述协议内容";
  }
}

agreementText.addEventListener("scroll", () => {
  if (agreementText.scrollTop + agreementText.clientHeight >= agreementText.scrollHeight - 4) {
    reachedBottom = true;
    updateAgreementState();
    renderHint();
  }
});

const agreementTimer = setInterval(() => {
  if (secondsLeft > 0) {
    secondsLeft--;
    countdownEl.textContent = secondsLeft;
  }
  if (secondsLeft <= 0) {
    clearInterval(agreementTimer);
  }
  updateAgreementState();
  renderHint();
}, 1000);

agreementConfirm.addEventListener("click", () => {
  if (agreementConfirm.disabled) return;
  localStorage.setItem("tieba_backup_agreed", "true");
  overlay.classList.remove("show");
});

if (localStorage.getItem("tieba_backup_agreed") === "true") {
  overlay.classList.remove("show");
} else {
  overlay.classList.add("show");
}
renderHint();

const tabs = document.querySelectorAll(".tab");
const panels = {
  submit: document.getElementById("panel-submit"),
  query: document.getElementById("panel-query"),
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    Object.values(panels).forEach((p) => p.classList.remove("active"));
    panels[tab.dataset.tab].classList.add("active");
  });
});

const submitInput = document.getElementById("submit-input");
const submitBtn = document.getElementById("submit-btn");
const submitResult = document.getElementById("submit-result");
const queryInput = document.getElementById("query-input");
const queryBtn = document.getElementById("query-btn");
const queryResult = document.getElementById("query-result");

function setResult(el, html, cls) {
  el.className = "result show";
  el.innerHTML = html;
  if (cls) el.querySelector("div")?.classList.add(cls);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// 倒计时：估测到下一个整点（本地端每 1 小时轮询一次）
let countdownTimer = null;
function startCountdown(el) {
  clearInterval(countdownTimer);
  const tick = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 0, 0);
    const remain = Math.max(0, Math.floor((next - now) / 1000));
    const mm = String(Math.floor(remain / 60)).padStart(2, "0");
    const ss = String(remain % 60).padStart(2, "0");
    el.querySelector(".countdown").textContent = `${mm}:${ss}`;
    if (remain <= 0) {
      clearInterval(countdownTimer);
      el.querySelector(".hint").textContent = "现在可以到「查询下载」页查询了";
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

submitBtn.addEventListener("click", async () => {
  const tid = extractTid(submitInput.value);
  if (!tid) {
    setResult(submitResult, `<div class="err">请输入有效的链接或 ID</div>`);
    return;
  }
  submitBtn.disabled = true;
  submitResult.className = "result";
  try {
    const data = await postJSON("/api/submit", { url: submitInput.value, agreed: true });
    if (data.ok && data.code === "CREATED") {
      setResult(
        submitResult,
        `<div class="ok">备份任务已创建，请在 <span class="countdown">--:--</span> 后尝试查询下载</div>
         <div class="hint meta">每1h检查一次任务，实际完成时间可能略有浮动，可尝试提前查询下载</div>`
      );
      startCountdown(submitResult);
    } else if (data.ok && data.code === "EXISTS") {
      setResult(
        submitResult,
        `<div class="ok">已有备份数据：${escapeHtml(data.title || "帖子 " + tid)}</div>
         <a class="dl-link" href="${data.downloadUrl}">下载 txt</a>`
      );
    } else if (data.ok && data.code === "IN_PROGRESS") {
      setResult(submitResult, `<div class="ok">${escapeHtml(data.message)}</div>`);
    } else if (data.ok && data.code === "REQUEUED") {
      setResult(
        submitResult,
        `<div class="ok">${escapeHtml(data.message)}</div>
         <div class="hint meta">上次任务失败已重新排队，请稍后到「查询下载」页查询</div>`
      );
    } else {
      setResult(submitResult, `<div class="err">${escapeHtml(data.message || "提交失败，请重试")}</div>`);
    }
  } catch (e) {
    setResult(submitResult, `<div class="err">网络错误，请重试</div>`);
  } finally {
    submitBtn.disabled = false;
  }
});

queryBtn.addEventListener("click", async () => {
  const tid = extractTid(queryInput.value);
  if (!tid) {
    setResult(queryResult, `<div class="err">请输入有效的 ID</div>`);
    return;
  }
  queryBtn.disabled = true;
  queryResult.className = "result";
  try {
    const res = await fetch(`/api/query?tid=${encodeURIComponent(tid)}`);
    const data = await res.json();
    if (data.code === "DONE") {
      setResult(
        queryResult,
        `<div class="ok">备份已完成：${escapeHtml(data.title || "帖子 " + tid)}</div>
         <a class="dl-link" href="${data.downloadUrl}">下载 txt</a>
         <div class="meta">文件大小：${(data.fileSize / 1024).toFixed(1)} KB</div>`
      );
    } else if (data.code === "IN_PROGRESS") {
      setResult(queryResult, `<div>${escapeHtml(data.message)}</div>`);
    } else if (data.code === "NOT_FOUND") {
      setResult(queryResult, `<div>${escapeHtml(data.message)}</div>`);
    } else if (data.code === "FAILED") {
      setResult(queryResult, `<div class="err">备份失败${data.error ? "：" + escapeHtml(data.error) : ""}，可到「提交备份」重新提交</div>`);
    } else {
      setResult(queryResult, `<div class="err">${escapeHtml(data.message || "查询失败")}</div>`);
    }
  } catch (e) {
    setResult(queryResult, `<div class="err">网络错误，请重试</div>`);
  } finally {
    queryBtn.disabled = false;
  }
});

// 回车提交
submitInput.addEventListener("keydown", (e) => e.key === "Enter" && submitBtn.click());
queryInput.addEventListener("keydown", (e) => e.key === "Enter" && queryBtn.click());
