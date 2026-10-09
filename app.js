const APP_VERSION = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';

function showUpdateBanner(onUpdateClick) {
  const banner = document.getElementById('updateBanner');
  const updateBtn = document.getElementById('updateBannerBtn');
  const dismissBtn = document.getElementById('updateBannerDismiss');
  if (!banner) return;

  banner.classList.add('show');
  updateBtn.onclick = onUpdateClick;
  dismissBtn.onclick = () => banner.classList.remove('show');
}

function promptUpdate(registration) {
  showUpdateBanner(() => {
    
    if (registration.waiting) {
      registration.waiting.postMessage('SKIP_WAITING');
    }
  });
}

function initUpdateWatcher(registration) {

  if (registration.waiting && navigator.serviceWorker.controller) {
    promptUpdate(registration);
  }

  registration.addEventListener('updatefound', () => {
    const newWorker = registration.installing;
    if (!newWorker) return;
    newWorker.addEventListener('statechange', () => {
      if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
        promptUpdate(registration);
      }
    });
  });

  let hasReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hasReloaded) return;
    hasReloaded = true;
    window.location.reload();
  });

  const POLL_INTERVAL_MS = 5 * 60 * 1000; 
  setInterval(() => {
    registration.update().catch((err) => console.warn('SW update check failed:', err));
  }, POLL_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      registration.update().catch((err) => console.warn('SW update check failed:', err));
    }
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`./sw.js?v=${encodeURIComponent(APP_VERSION)}`, { updateViaCache: 'none' })
      .then((reg) => {
        console.log('Service Worker registered! Scope:', reg.scope, '| App version:', APP_VERSION);
        initUpdateWatcher(reg);
      })
      .catch((err) => console.log('Service Worker registration failed (this is OK if sw.js is not deployed yet):', err));
  });
}

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  onSnapshot,
  deleteDoc,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCAPN2IYabEgntrRRQiurheGWT_-ZBDtCE",
  authDomain: "bill-7486c.firebaseapp.com",
  projectId: "bill-7486c",
  storageBucket: "bill-7486c.firebasestorage.app",
  messagingSenderId: "1020588999488",
  appId: "1:1020588999488:web:98039abe65a76429d130a5",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth();

const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

let currentUserId = null,
  billItems = [],
  items = [],
  allHistory = [],
  stockData = {};

let recycleBinData = [];

const RECYCLE_BIN_EXPIRY_DAYS = 7;
const RECYCLE_BIN_EXPIRY_MS = RECYCLE_BIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

let autoCleanupInProgress = false;

let stockDeductedForCurrentBill = false;
let activeUnsubscribers = [];

function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function itemDocId(name) {
  return String(name).trim();
}

function hasInvalidDocIdChars(value) {
  return String(value).includes("/");
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark-mode", isDark);
  const themeBtn = document.getElementById("themeToggleBtn");
  if (themeBtn) themeBtn.textContent = isDark ? "Light" : "Dark";
}

const savedTheme = localStorage.getItem("easybill-theme");
const preferredTheme = savedTheme || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
applyTheme(preferredTheme);

window.toggleTheme = () => {
  const nextTheme = document.body.classList.contains("dark-mode") ? "light" : "dark";
  localStorage.setItem("easybill-theme", nextTheme);
  applyTheme(nextTheme);
};

function createOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

function cleanupListeners() {
  activeUnsubscribers.forEach((unsubscribe) => {
    try { unsubscribe(); } catch (e) { console.warn("Listener cleanup failed:", e); }
  });
  activeUnsubscribers = [];
}

function listenToQuery(ref, next) {
  const unsubscribe = onSnapshot(ref, next, (err) => {
    console.error("Firestore listener error:", err);
    alert("Data sync error: " + err.message);
  });
  activeUnsubscribers.push(unsubscribe);
}

window.openSectionsStack = [];

let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installBtn = document.getElementById('installBtn');
  if (installBtn) installBtn.style.display = 'inline-block';
});

window.installApp = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') {
    document.getElementById('installBtn').style.display = 'none';
  }
  deferredPrompt = null;
};

function pushSectionState(sectionId) {
  if (!window.openSectionsStack.includes(sectionId)) {
    window.openSectionsStack.push(sectionId);
    history.pushState({ section: sectionId }, "");
  }
}

window.addEventListener("popstate", (event) => {
  if (window.openSectionsStack.length > 0) {
    const lastSection = window.openSectionsStack.pop();

    if (lastSection === "forgotModal") {
      forgotModal.style.display = "none";
    } else if (lastSection === "stockSection") {
      stockSectionContainer.classList.remove("active");
    } else if (lastSection === "addNewItem") {
      addNewItemForm.classList.remove("active");
    } else if (lastSection === "editItems") {
      document.getElementById("editItemsContainer").classList.remove("active");
    } else if (lastSection === "history") {
      historyContainer.classList.remove("active");
    } else if (lastSection === "recycleBin") {
      document.getElementById("recycleBinContainer").classList.remove("active");
    }

    if (window.openSectionsStack.length > 0) {
      history.pushState({ section: window.openSectionsStack[window.openSectionsStack.length - 1] }, "");
    }
  }
});

history.replaceState({ section: null }, "");

window.openForgotModal = () => {
  forgotModal.style.display = "flex";
  pushSectionState("forgotModal");
};
window.closeForgotModal = () => {
  forgotModal.style.display = "none";
  if (window.openSectionsStack.includes("forgotModal")) {
    window.openSectionsStack = window.openSectionsStack.filter(s => s !== "forgotModal");
    history.back();
  }
};

window.login = () => {
  const emailVal = email.value.trim();
  const passVal = password.value.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailVal || !passVal) return alert("Please enter both email and password!");
  if (!emailRegex.test(emailVal)) return alert("Please enter a valid email address!");

  const btn = document.getElementById("loginBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Signing in..."; }

  signInWithEmailAndPassword(auth, emailVal, passVal)
    .catch((err) => alert("Login Failed: " + err.message))
    .finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = "Sign In"; }
    });
};

window.logout = () => signOut(auth);

window.sendForgotEmail = () => {
  const fEmail = forgotEmail.value.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!fEmail) return alert("Please enter your registered email!");
  if (!emailRegex.test(fEmail)) return alert("Please enter a valid email address!");

  sendPasswordResetEmail(auth, fEmail)
    .then(() => {
      alert("Password reset link sent to your email!");
      closeForgotModal();
    })
    .catch((err) => alert("Error: " + err.message));
};

function listenItemsFromDB() {
  listenToQuery(collection(db, "users", currentUserId, "items"), (snap) => {
    items = [];
    snap.forEach((d) => items.push(d.data()));
    renderItemsDropdown();
    renderStockTable();
    if (document.getElementById("editItemsContainer").classList.contains("active")) {
      renderItemsList();
    }
  });
}

function listenBillFromDB() {
  listenToQuery(doc(db, "users", currentUserId, "currentBill", "bill"), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    billItems = data.items || [];
    if (customerName && data.customerName !== undefined) customerName.value = data.customerName || "";
    if (customerWhatsapp && data.customerWhatsapp !== undefined) customerWhatsapp.value = data.customerWhatsapp || "";
    if (customerCountryCode && data.customerCountryCode !== undefined) customerCountryCode.value = data.customerCountryCode || "91";
    if (tax && data.tax !== undefined) tax.value = data.tax || 0;
    if (discount && data.discount !== undefined) discount.value = data.discount || 0;
    if (billItems.length === 0) stockDeductedForCurrentBill = false;
    renderBill();
    renderStockTable();
  });
}

function listenStockFromDB() {
  listenToQuery(doc(db, "users", currentUserId, "stockData", "info"), (snap) => {
    stockData = snap.exists() ? snap.data() : {};
    renderStockTable();
  });
}

function listenHistoryFromDB() {
  listenToQuery(collection(db, "users", currentUserId, "history"), (snap) => {
    allHistory = [];
    snap.forEach((h) => allHistory.push({ ...h.data(), id: h.id }));
    allHistory.sort((a, b) => {
      const bTime = b.createdAt?.toMillis?.() || Date.parse(b.isoDate || "") || 0;
      const aTime = a.createdAt?.toMillis?.() || Date.parse(a.isoDate || "") || 0;
      return bTime - aTime;
    });
    searchHistory();
  });
}

function listenRecycleBinFromDB() {
  listenToQuery(collection(db, "users", currentUserId, "recycleBin"), (snap) => {
    recycleBinData = [];
    snap.forEach((r) => recycleBinData.push({ ...r.data(), id: r.id }));
    recycleBinData.sort((a, b) => {
      const bTime = Date.parse(b.deletedAt || "") || 0;
      const aTime = Date.parse(a.deletedAt || "") || 0;
      return bTime - aTime;
    });
    if (document.getElementById("recycleBinContainer").classList.contains("active")) {
      renderRecycleBin();
    }
    
    runRecycleBinAutoCleanup();
  });
}

async function runRecycleBinAutoCleanup() {
  if (autoCleanupInProgress || !currentUserId) return;

  const now = Date.now();
  const expiredEntries = recycleBinData.filter((entry) => {
    const deletedAtMs = Date.parse(entry.deletedAt || "");
    if (!Number.isFinite(deletedAtMs)) return false; 
    return (now - deletedAtMs) > RECYCLE_BIN_EXPIRY_MS;
  });

  if (expiredEntries.length === 0) return;

  autoCleanupInProgress = true;
  try {
    for (const entry of expiredEntries) {
      try {
        await deleteDoc(doc(db, "users", currentUserId, "recycleBin", entry.id));
        console.log(`Recycle Bin: auto-purged expired entry "${entry.label}" (deleted ${RECYCLE_BIN_EXPIRY_DAYS}+ days ago).`);
      } catch (e) {
        console.warn(`Recycle Bin: failed to auto-purge entry ${entry.id}: ${e.message}`);
      }
    }
  } finally {
    autoCleanupInProgress = false;
  }
}

window.handleDropdownAction = function(selectEl) {
  const val = selectEl.value;
  if (!val) return;

  if (val === "addItem") toggleAddItemForm();
  else if (val === "stock") toggleStockSection();
  else if (val === "history") toggleHistory();
  else if (val === "editItems") toggleEditItems();
  else if (val === "recycleBin") toggleRecycleBin();
  else if (val === "print") printBill();

  selectEl.selectedIndex = 0;
};

window.toggleStockSection = () => {
  const isShow = !stockSectionContainer.classList.contains("active");
  if (isShow) {
    stockSectionContainer.classList.add("active");
    pushSectionState("stockSection");
    renderStockTable();
  } else {
    stockSectionContainer.classList.remove("active");
    window.openSectionsStack = window.openSectionsStack.filter(s => s !== "stockSection");
    history.back();
  }
};

window.clearStockSearch = () => {
  document.getElementById("stockSearchInput").value = "";
  renderStockTable();
};

function unitQuantityInBase(unit, baseUnit) {
  const cleanUnit = String(unit || "").toLowerCase().trim();
  const cleanBase = String(baseUnit || "").toLowerCase().trim();
  const num = parseFloat(cleanUnit);
  const amount = Number.isFinite(num) ? num : 1;

  if (cleanBase === "kg") {
    if (cleanUnit.includes("kg")) return amount;
    if (cleanUnit.includes("g")) return amount / 1000;
  }

  if (cleanBase === "liter") {
    if (cleanUnit.includes("ml")) return amount / 1000;
    if (cleanUnit.includes("liter") || cleanUnit.endsWith("l")) return amount;
  }

  return 1;
}

function applyStockDeduction(currentStock, itemsSnapshot) {
  const updatedStock = { ...(currentStock || {}) };
  let updated = false;

  itemsSnapshot.forEach((bi) => {
    const matchedItemKey = Object.keys(updatedStock).find((k) => k.toLowerCase() === String(bi.name || "").toLowerCase().trim());
    if (!matchedItemKey) return;

    const stockEntry = updatedStock[matchedItemKey] || {};
    const currentTotalReceived = parseFloat(stockEntry.totalReceived || 0);
    const soldQty = parseFloat(bi.qty || 0);
    const actualDeduct = soldQty * unitQuantityInBase(bi.unit, stockEntry.unit);
    const newTotal = Math.max(0, currentTotalReceived - actualDeduct);

    updatedStock[matchedItemKey] = { ...stockEntry, totalReceived: newTotal };
    updated = true;
  });

  return { updated, updatedStock };
}

window.renderStockTable = function() {
  const stockTableList = document.getElementById("stockTableList");
  if (!stockTableList) return;

  const searchQuery = document.getElementById("stockSearchInput") ? document.getElementById("stockSearchInput").value.toLowerCase().trim() : "";
  const filteredItems = items.filter(it => it.name.toLowerCase().includes(searchQuery));

  if (filteredItems.length === 0) {
    stockTableList.innerHTML = "<p style='text-align:center; color:var(--text-muted); padding:20px;'>No items found in inventory.</p>";
    return;
  }

  stockTableList.innerHTML = "";
  filteredItems.forEach(it => {
    let itemStock = stockData[it.name] || { supplier: "Not Specified", totalReceived: 0, unit: "" };
    let totalReceived = parseFloat(itemStock.totalReceived || 0);
    let itemUnit = itemStock.unit || "";

    const itemNameArg = JSON.stringify(it.name).replace(/'/g, "&#39;");

    stockTableList.innerHTML += `
    <div style="background: white; padding: 14px; border-radius: var(--radius); margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid var(--border-color); border-left: 4px solid #8b5cf6;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <div>
          <b style="font-size:1.05rem; color:var(--text-main);"> ${escapeHTML(it.name)}</b>
          <div style="margin-top:3px; font-size:0.85rem; color:var(--text-muted);">
             <b>Supplier:</b> <span style="color:#0284c7;">${escapeHTML(itemStock.supplier)}</span>
          </div>
        </div>
        <div>
          <button onclick='updateStockEntry(${itemNameArg})' style="background:#8b5cf6; color:white; border:none; padding:7px 14px; border-radius:8px; cursor:pointer; font-weight:600; font-size:12px; box-shadow:0 1px 2px rgba(0,0,0,0.05);">Update Stock</button>
        </div>
      </div>
      <div style="margin-top:10px; padding-top:8px; border-top:1px dashed var(--border-color); font-size:0.9rem;">
         Remaining Stock: <b style="color:${totalReceived > 0 ? 'var(--success)' : 'var(--danger)'};">${totalReceived} ${escapeHTML(itemUnit)}</b>
      </div>
    </div>`;
  });
};

window.updateStockEntry = async function(itemName) {
  let currentInfo = stockData[itemName] || { supplier: "", totalReceived: 0, unit: "" };
  let supplier = prompt(`Enter Supplier name for '${itemName}':`, currentInfo.supplier);
  if (supplier === null) return;
  if (!supplier.trim()) return alert("Supplier name cannot be empty!");

  let unitLabel = currentInfo.unit ? ` (in ${currentInfo.unit})` : "";
  let qtyStr = prompt(`Enter total remaining stock for '${itemName}'${unitLabel}:`, currentInfo.totalReceived);
  if (qtyStr === null) return;
  let totalReceived = parseFloat(qtyStr);
  if (isNaN(totalReceived) || totalReceived < 0) return alert("Please enter a valid non-negative quantity!");

  stockData[itemName] = { ...currentInfo, supplier: supplier.trim(), totalReceived };
  try {
    await setDoc(doc(db, "users", currentUserId, "stockData", "info"), stockData);
    alert("Stock updated successfully!");
    renderStockTable();
  } catch (e) {
    alert("Error: " + e.message);
  }
};

function renderHistoryList(historyArray) {
  const historyList = document.getElementById("historyList");
  historyList.innerHTML = "";
  if (historyArray.length === 0) {
    historyList.innerHTML = "<p style='text-align:center; color:var(--text-muted); padding:20px;'>No bills found matching your filter.</p>";
    return;
  }
  historyArray.forEach((h) => {
    const totalAmt = parseFloat(h.total) || 0;
    let initialPaid = h.paidAmount !== undefined ? parseFloat(h.paidAmount) : totalAmt;
    let paymentsList = h.payments || [];
    let extraPaidSum = paymentsList.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    let totalPaidAmt = initialPaid + extraPaidSum;
    let dueAmt = totalAmt - totalPaidAmt;
    if (dueAmt < 0) dueAmt = 0; 

    let statusBadge = dueAmt <= 0 ? `<span class="badge-paid">Paid</span>` : `<span class="badge-due">Due  Due: Rs.${dueAmt.toFixed(2)}</span>`;
    let clearDueButton = dueAmt > 0 ? `<button onclick="clearDue('${h.id}', ${dueAmt})" style="background:var(--success); color:white; border:none; border-radius:8px; padding:7px 12px; cursor:pointer; font-weight:600; font-size:12px; margin-right:6px;">Pay Due</button>` : '';

    let paymentsLogHTML = "";
    if (paymentsList.length > 0) {
      paymentsLogHTML = `<div style="margin-top:6px; font-size:0.8rem; background:#f0fdf4; padding:6px 10px; border-radius:8px; border:1px solid #dcfce7;">
        <b>History:</b> ${paymentsList.map(p => `<span>- Rs.${escapeHTML(p.amount)} (${escapeHTML(p.date)})</span>`).join(", ")}
      </div>`;
    }

    historyList.innerHTML += `
    <div style="margin-bottom:14px; background: #fff; padding: 14px; border-radius: var(--radius); box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid var(--border-color);">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px dashed var(--border-color); padding-bottom: 8px; margin-bottom: 8px; flex-wrap:wrap; gap:6px;">
        <div><b style="color:var(--text-main);"> ${escapeHTML(h.customer)}</b> ${statusBadge}</div>
        <span style="color: var(--text-muted); font-size: 0.85rem;"> ${escapeHTML(h.date)}</span>
      </div>
      ${(h.items || []).map((it, j) => `<div style="color:var(--text-muted); font-size:0.9rem; margin-bottom:3px;">${j + 1}. ${escapeHTML(it.name)} - ${escapeHTML(it.unit)} | Qty: ${escapeHTML(it.qty)} = Rs.${(parseFloat(it.total) || 0).toFixed(2)}</div>`).join("")}
      <div style="margin-top:8px; font-size:0.9rem; color:var(--text-main);">
        <span>Total: <b>Rs.${totalAmt.toFixed(2)}</b></span> | <span style="color:var(--success);">Paid: <b>Rs.${totalPaidAmt.toFixed(2)}</b></span> | <span style="color:var(--danger);">Due: <b>Rs.${dueAmt.toFixed(2)}</b></span>
      </div>
      ${paymentsLogHTML}
      <div style="display:flex; justify-content:flex-end; align-items:center; margin-top:10px; gap:6px;">
        ${clearDueButton}
        <button onclick="removeHistoryItem('${h.id}')" style="background:#fee2e2; color:var(--danger); border:none; border-radius:8px; padding:7px 12px; cursor:pointer; font-weight:600; font-size:12px;"> Delete</button>
      </div>
    </div>`;
  });
}

window.clearDue = async function (id, currentDue) {
  let payStr = prompt(`Current Due is Rs.${currentDue.toFixed(2)}.\nEnter amount being paid now:`, currentDue);
  if (payStr === null) return;
  let paid = parseFloat(payStr);
  if (isNaN(paid) || paid <= 0) return alert("Please enter a valid positive payment amount!");
  if (paid > currentDue + 0.05) return alert("Payment amount cannot exceed the pending due amount!");

  const paymentDate = new Date().toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

  try {
    const historyRef = doc(db, "users", currentUserId, "history", id);
    await runTransaction(db, async (transaction) => {
      const historySnap = await transaction.get(historyRef);
      if (!historySnap.exists()) throw new Error("Record not found!");
      const record = historySnap.data();
      const totalAmt = parseFloat(record.total) || 0;
      const initialPaid = record.paidAmount !== undefined ? parseFloat(record.paidAmount) : totalAmt;
      const existingPayments = record.payments || [];
      const extraPaidSum = existingPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      const latestDue = Math.max(0, totalAmt - initialPaid - extraPaidSum);
      if (paid > latestDue + 0.05) throw new Error("Payment amount cannot exceed the pending due amount!");
      transaction.update(historyRef, { payments: [...existingPayments, { amount: paid, date: paymentDate }] });
    });
    alert("Payment recorded successfully!");
  } catch (e) {
    alert("Error: " + e.message);
  }
};

window.searchHistory = function () {
  const nameQuery = document.getElementById("historySearchName").value.toLowerCase().trim();
  const dateQueryRaw = document.getElementById("historySearchDate").value;
  const filtered = allHistory.filter((h) => {
    const customer = String(h.customer || "").toLowerCase();
    const recordIsoDate = String(h.isoDate || "").slice(0, 10);
    return (nameQuery === "" || customer.includes(nameQuery)) && (dateQueryRaw === "" || recordIsoDate === dateQueryRaw);
  });
  renderHistoryList(filtered);
};

window.clearHistorySearch = function () {
  document.getElementById("historySearchName").value = "";
  document.getElementById("historySearchDate").value = "";
  renderHistoryList(allHistory);
};

async function softDeleteRecord(entityType, originalId, data, label, originalDocRef) {
  const now = new Date();
  const recycleBinRef = doc(collection(db, "users", currentUserId, "recycleBin"));

  await runTransaction(db, async (transaction) => {
    transaction.set(recycleBinRef, {
      entityType,
      originalId,
      data,
      label,
      deletedAt: now.toISOString(),
      deletedAtDisplay: now.toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }),
    });
    transaction.delete(originalDocRef);
  });
}

window.removeHistoryItem = async function (id) {
  if (!confirm("Move this bill record to the Recycle Bin?")) return;
  try {
    const record = allHistory.find((h) => h.id === id);
    if (!record) return alert("Record not found!");
    const { id: _drop, ...recordData } = record;
    const originalDocRef = doc(db, "users", currentUserId, "history", id);
    await softDeleteRecord("history", id, recordData, record.customer || "Walk-in Customer", originalDocRef);
    alert("Bill moved to Recycle Bin. You can restore it from there.");
  } catch (e) {
    alert("Error: " + e.message);
  }
};

onAuthStateChanged(auth, (user) => {
  cleanupListeners();
  if (user) {
    currentUserId = user.uid;
    authSection.style.display = "none";
    appSection.style.display = "block";
    listenItemsFromDB();
    listenBillFromDB();
    listenStockFromDB();
    listenHistoryFromDB();
    listenRecycleBinFromDB();
  } else {
    currentUserId = null;
    authSection.style.display = "flex";
    appSection.style.display = "none";
    items = []; billItems = []; stockData = {};
    allHistory = []; recycleBinData = [];
  }
});

function renderItemsDropdown() {
  itemSelect.innerHTML = "";
  itemSelect.appendChild(createOption("", "-- Search or Select Item --"));
  items.forEach((it) => {
    itemSelect.appendChild(createOption(it.name, it.name));
  });
  $('#itemSelect').trigger('change.select2');
}

window.addNewItem = async function () {
  const name = newItemName.value.trim();
  const baseUnit = newItemUnit.value;
  const basePrice = parseFloat(newItemPrice.value);

  if (!name) return alert("Item name cannot be empty!");
  if (hasInvalidDocIdChars(name)) return alert("Item name cannot contain '/'.");
  if (!baseUnit) return alert("Please select a base unit!");
  if (isNaN(basePrice) || basePrice <= 0) return alert("Please enter a valid positive price!");

  const dup = items.find(i => i.name.toLowerCase() === name.toLowerCase());
  if (dup) return alert(`An item named '${dup.name}' already exists! Use "Edit Items" to modify it instead.`);

  const btn = document.getElementById("saveNewItemBtn");
  if (btn) { btn.disabled = true; }

  let units = {};
  if (baseUnit === "kg") {
    units["100g"] = +(0.1 * basePrice).toFixed(2);
    units["500g"] = +(0.5 * basePrice).toFixed(2);
    units["1kg"] = basePrice;
    units["5kg"] = +(5 * basePrice).toFixed(2);
    units["10kg"] = +(10 * basePrice).toFixed(2);
  } else if (baseUnit === "liter") {
    units["100ml"] = +(0.1 * basePrice).toFixed(2);
    units["500ml"] = +(0.5 * basePrice).toFixed(2);
    units["1liter"] = basePrice;
    units["5liter"] = +(5 * basePrice).toFixed(2);
  } else {
    units[baseUnit] = basePrice;
  }

  try {
    await setDoc(doc(db, "users", currentUserId, "items", itemDocId(name)), { name, units, codes: [] });
    let supplier = prompt(`Item added! Enter supplier for '${name}':`, "Direct");
    if (supplier === null) supplier = "Direct";

    let qtyReceived = prompt(`Enter total stock received for '${name}' (in ${baseUnit}):`, "0");
    if (qtyReceived === null) qtyReceived = "0";
    let parsedQty = parseFloat(qtyReceived);
    if (isNaN(parsedQty) || parsedQty < 0) parsedQty = 0;

    stockData[name] = { supplier: supplier.trim() || "Unknown", totalReceived: parsedQty, unit: baseUnit };
    await setDoc(doc(db, "users", currentUserId, "stockData", "info"), stockData);

    newItemName.value = ""; newItemUnit.value = ""; newItemPrice.value = "";
    addNewItemForm.classList.remove("active");
    if (window.openSectionsStack.includes("addNewItem")) {
      window.openSectionsStack = window.openSectionsStack.filter(s => s !== "addNewItem");
      history.back();
    }
    alert("Item and stock added successfully!");
  } catch (e) {
    alert("Error: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; }
  }
};

window.toggleEditItems = () => {
  const container = document.getElementById("editItemsContainer");
  const isShow = !container.classList.contains("active");
  if (isShow) {
    container.classList.add("active");
    pushSectionState("editItems");
    renderItemsList();
  } else {
    container.classList.remove("active");
    window.openSectionsStack = window.openSectionsStack.filter(s => s !== "editItems");
    history.back();
  }
};

window.clearEditSearch = () => {
  document.getElementById("editSearchInput").value = "";
  renderItemsList();
};

window.renderItemsList = function() {
  const itemsListEl = document.getElementById("itemsList");
  if (!itemsListEl) return;
  const searchQuery = document.getElementById("editSearchInput") ? document.getElementById("editSearchInput").value.toLowerCase().trim() : "";
  const filteredItems = items.filter(it => it.name.toLowerCase().includes(searchQuery));

  itemsListEl.innerHTML = "";
  if (filteredItems.length === 0) {
    itemsListEl.innerHTML = "<p style='text-align:center; color:var(--text-muted); padding:20px;'>No items found.</p>";
    return;
  }

  filteredItems.forEach((it) => {
    const unitsView = Object.entries(it.units).map(([u, p]) => `${escapeHTML(u)}: Rs.${p}`).join(", ");
    const itemNameArg = JSON.stringify(it.name).replace(/'/g, "&#39;");
    itemsListEl.innerHTML += `<div class="item-row">
      <span><b>${escapeHTML(it.name)}</b> <br><small style="color:var(--text-muted);">(${unitsView})</small></span>
      <div>
        <button onclick='openEditItemByName(${itemNameArg})' style="background:#0ea5e9; color:white; border:none; padding:7px 12px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:600;">Edit</button>
        <button onclick='removeItemFromDB(${itemNameArg})' style="background:#fee2e2; color:var(--danger); border:none; padding:7px 12px; margin-left:6px; cursor:pointer; font-size:12px; font-weight:600;">Delete</button>
      </div>
    </div>`;
  });
};

window.removeItemFromDB = async function (name) {
  if (!confirm(`Move '${name}' to the Recycle Bin?`)) return;
  try {
    const record = items.find((i) => i.name === name);
    if (!record) return alert("Item not found!");
    const docId = itemDocId(name);
    const originalDocRef = doc(db, "users", currentUserId, "items", docId);
    const combinedData = { ...record, __stockEntry: stockData[name] || null };
    await softDeleteRecord("item", docId, combinedData, name, originalDocRef);
    alert("Item moved to Recycle Bin. You can restore it from there.");
  } catch (e) {
    alert("Error: " + e.message);
  }
};

window.openEditItemByName = function(name) {
  const item = items.find(i => i.name === name);
  if (!item) return alert("Item not found (it may have just been deleted or renamed).");
  openEditItemForm(item);
};

window.openEditItemForm = (item) => {
  const itemsListEl = document.getElementById("itemsList");
  const unitsString = Object.entries(item.units).map(([u, p]) => `${u}:${p}`).join(",");
  itemsListEl.innerHTML = `
    <div style="background:#fff; padding:16px; border-radius:var(--radius); border:1px solid var(--border-color);">
      <input type="hidden" id="oldItemName" value="${escapeHTML(item.name)}" />
      <label>Item Name</label>
      <input type="text" id="editItemName" value="${escapeHTML(item.name)}" />
      <label>Units & Prices (unit:price,unit:price)</label>
      <input type="text" id="editItemUnits" value="${escapeHTML(unitsString)}" />
      <div style="margin-top:14px; display:flex; gap:10px;">
        <button onclick="saveEditedItem()" style="background:var(--success); color:white; border:none; padding:10px 14px; border-radius:8px; cursor:pointer; font-size:13px; font-weight:600; flex:1;"> Save</button>
        <button onclick="renderItemsList()" style="background:#f1f5f9; color:var(--text-main); border:none; padding:10px 14px; border-radius:8px; cursor:pointer; font-size:13px; font-weight:600; flex:1;">x Cancel</button>
      </div>
    </div>
  `;
};

window.saveEditedItem = async function() {
  const oldNameInput = document.getElementById("oldItemName");
  const oldName = oldNameInput ? oldNameInput.value.trim() : "";
  const name = document.getElementById("editItemName").value.trim();
  const unitsStr = document.getElementById("editItemUnits").value.trim();

  if (!name) return alert("Item name cannot be empty!");
  if (hasInvalidDocIdChars(name)) return alert("Item name cannot contain '/'.");
  if (!unitsStr) return alert("Units configuration cannot be empty!");

  const collision = items.find(i => i.name.toLowerCase() === name.toLowerCase() && i.name.toLowerCase() !== oldName.toLowerCase());
  if (collision) return alert(`Another item named '${collision.name}' already exists! Please choose a different name.`);

  let units = {};
  try {
    unitsStr.split(",").forEach((pair) => {
      let [u, p] = pair.split(":");
      if (!u || !p || isNaN(parseFloat(p))) throw new Error("Invalid format");
      units[u.trim()] = parseFloat(p.trim());
    });
  } catch (err) {
    return alert("Invalid units format! Please use format like: 1kg:50,5kg:230");
  }

  try {
    await setDoc(doc(db, "users", currentUserId, "items", itemDocId(name)), { name, units, codes: [] });

    if (oldName && oldName !== name) {
      try {
        await deleteDoc(doc(db, "users", currentUserId, "items", itemDocId(oldName)));
      } catch (delErr) {
        console.error("Could not delete old item doc '" + oldName + "': " + delErr.message);
      }
    }

    if (oldName && oldName !== name && stockData[oldName]) {
      stockData[name] = stockData[oldName];
      delete stockData[oldName];
      await setDoc(doc(db, "users", currentUserId, "stockData", "info"), stockData);
    }

    alert("Item updated successfully Save");
    renderItemsList();
  } catch (e) {
    alert("Error: " + e.message);
  }
};


window.toggleRecycleBin = () => {
  const container = document.getElementById("recycleBinContainer");
  const isShow = !container.classList.contains("active");
  if (isShow) {
    container.classList.add("active");
    pushSectionState("recycleBin");
    renderRecycleBin();
  } else {
    container.classList.remove("active");
    window.openSectionsStack = window.openSectionsStack.filter(s => s !== "recycleBin");
    history.back();
  }
};


window.renderRecycleBin = function() {
  const listEl = document.getElementById("recycleBinList");
  if (!listEl) return;

  const searchQuery = document.getElementById("recycleBinSearchInput")
    ? document.getElementById("recycleBinSearchInput").value.toLowerCase().trim()
    : "";

  const filtered = recycleBinData.filter((r) =>
    String(r.label || "").toLowerCase().includes(searchQuery)
  );

  if (filtered.length === 0) {
    listEl.innerHTML = "<p style='text-align:center; color:var(--text-muted); padding:20px;'>Recycle Bin is empty.</p>";
    return;
  }

  listEl.innerHTML = "";
  filtered.forEach((r) => {
    const typeBadge = r.entityType === "item"
      ? `<span class="badge-type-item">Item</span>`
      : `<span class="badge-type-bill">Bill</span>`;

    let subtitle = "";
    if (r.entityType === "item" && r.data && r.data.units) {
      subtitle = Object.entries(r.data.units).map(([u, p]) => `${escapeHTML(u)}: Rs.${p}`).join(", ");
    } else if (r.entityType === "history" && r.data) {
      subtitle = `Total: Rs.${parseFloat(r.data.total || 0).toFixed(2)} | Date: ${escapeHTML(r.data.date || "")}`;
    }

    const deletedAtMs = Date.parse(r.deletedAt || "");
    let expiryNote = "";
    if (Number.isFinite(deletedAtMs)) {
      const msRemaining = RECYCLE_BIN_EXPIRY_MS - (Date.now() - deletedAtMs);
      const daysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
      expiryNote = msRemaining > 0
        ? `<div style="margin-top:2px; font-size:0.78rem; color:var(--warning);">Auto-deletes in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}</div>`
        : `<div style="margin-top:2px; font-size:0.78rem; color:var(--danger);">Pending auto-delete...</div>`;
    }

    listEl.innerHTML += `
    <div style="background: var(--card-bg); padding: 14px; border-radius: var(--radius); margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid var(--border-color); border-left: 4px solid var(--danger);">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
        <div>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            ${typeBadge}
            <b style="font-size:1.02rem; color:var(--text-main);">${escapeHTML(r.label)}</b>
          </div>
          ${subtitle ? `<div style="margin-top:4px; font-size:0.85rem; color:var(--text-muted);">${subtitle}</div>` : ""}
          <div style="margin-top:4px; font-size:0.78rem; color:var(--text-muted);">Deleted: ${escapeHTML(r.deletedAtDisplay || r.deletedAt || "")}</div>
          ${expiryNote}
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button onclick="restoreRecycleBinItem('${r.id}')" style="background:var(--success); color:white; border:none; padding:7px 14px; border-radius:8px; cursor:pointer; font-weight:600; font-size:12px;">Restore</button>
          <button onclick="permanentlyDeleteRecycleBinItem('${r.id}')" style="background:var(--danger); color:white; border:none; padding:7px 14px; border-radius:8px; cursor:pointer; font-weight:600; font-size:12px;">Delete Forever</button>
        </div>
      </div>
    </div>`;
  });
};


async function restoreSingleEntry(entry) {
  if (entry.entityType === "item") {
    const { __stockEntry, ...itemData } = entry.data || {};
    await setDoc(doc(db, "users", currentUserId, "items", entry.originalId), itemData);
    if (__stockEntry) {
      stockData[itemData.name] = __stockEntry;
      await setDoc(doc(db, "users", currentUserId, "stockData", "info"), stockData);
    }
  } else if (entry.entityType === "history") {
    await setDoc(doc(db, "users", currentUserId, "history", entry.originalId), entry.data);
  }
  await deleteDoc(doc(db, "users", currentUserId, "recycleBin", entry.id));
}

window.restoreRecycleBinItem = async function(recycleBinId) {
  const entry = recycleBinData.find((r) => r.id === recycleBinId);
  if (!entry) return alert("Record not found (it may have already been restored or deleted).");
  if (!confirm(`Restore '${entry.label}' back to the active program?`)) return;
  try {
    await restoreSingleEntry(entry);
    alert("Restored successfully!");
  } catch (e) {
    alert("Error restoring: " + e.message);
  }
};


window.permanentlyDeleteRecycleBinItem = async function(recycleBinId) {
  const entry = recycleBinData.find((r) => r.id === recycleBinId);
  if (!entry) return alert("Record not found!");
  if (!confirm(`Permanently delete '${entry.label}'? This CANNOT be undone.`)) return;
  try {
    await deleteDoc(doc(db, "users", currentUserId, "recycleBin", entry.id));
    alert("Permanently deleted.");
  } catch (e) {
    alert("Error: " + e.message);
  }
};

window.restoreAllFromRecycleBin = async function() {
  if (recycleBinData.length === 0) return alert("Recycle Bin is already empty!");
  if (!confirm(`Restore all ${recycleBinData.length} item(s) in the Recycle Bin?`)) return;

  const entriesSnapshot = [...recycleBinData];
  let successCount = 0;
  let failCount = 0;

  for (const entry of entriesSnapshot) {
    try {
      await restoreSingleEntry(entry);
      successCount++;
    } catch (e) {
      console.error("Failed to restore entry " + entry.id + ": " + e.message);
      failCount++;
    }
  }

  alert(`Restore complete. Restored: ${successCount}. Failed: ${failCount}.`);
};

window.clearAllRecycleBin = async function() {
  if (recycleBinData.length === 0) return alert("Recycle Bin is already empty!");
  if (!confirm(`Permanently delete ALL ${recycleBinData.length} item(s) in the Recycle Bin? This CANNOT be undone.`)) return;

  const entriesSnapshot = [...recycleBinData];
  let successCount = 0;
  let failCount = 0;

  for (const entry of entriesSnapshot) {
    try {
      await deleteDoc(doc(db, "users", currentUserId, "recycleBin", entry.id));
      successCount++;
    } catch (e) {
      console.error("Failed to delete entry " + entry.id + ": " + e.message);
      failCount++;
    }
  }

  alert(`Clear complete. Deleted: ${successCount}. Failed: ${failCount}.`);
};

let saveBillTimeout;
async function saveCurrentBill() {
  clearTimeout(saveBillTimeout);
  saveBillTimeout = setTimeout(async () => {
    if (currentUserId) {
      await setDoc(doc(db, "users", currentUserId, "currentBill", "bill"), {
        items: billItems,
        customerName: customerName.value.trim(),
        customerWhatsapp: customerWhatsapp.value.trim(),
        customerCountryCode: customerCountryCode.value.trim() || "91",
        tax: parseFloat(tax.value) || 0,
        discount: parseFloat(discount.value) || 0,
      });
    }
  }, 500);
}

window.addOrUpdate = function () {
  const name = itemSelect.value, unit = unitSelect.value;
  const qtyVal = parseFloat(qty.value) || 0, pVal = parseFloat(price.value) || 0;
  if (!name || !unit || pVal <= 0 || qtyVal <= 0) return;

  const idx = billItems.findIndex((it) => it.name === name && it.unit === unit);
  const total = pVal * qtyVal;

  if (idx >= 0) billItems[idx] = { name, unit, price: pVal, qty: qtyVal, total };
  else billItems.push({ name, unit, price: pVal, qty: qtyVal, total });

  renderBill();
  saveCurrentBill();
};

document.getElementById('qty').addEventListener("input", addOrUpdate);
document.getElementById('price').addEventListener("input", addOrUpdate);

window.removeItem = (i) => {
  billItems.splice(i, 1);
  saveCurrentBill();
  renderBill();
};

window.resetBill = async () => {
  if (billItems.length === 0) return alert("Bill is already empty!");
  if (confirm("Reset current bill?")) {
    billItems = [];
    stockDeductedForCurrentBill = false;
    renderBill();
    if (currentUserId) {
      await setDoc(doc(db, "users", currentUserId, "currentBill", "bill"), {
        items: [],
        customerName: "",
        customerWhatsapp: "",
        customerCountryCode: "91",
        tax: 0,
        discount: 0,
      });
    }
  }
};

window.populateUnits = function () {
  const qtyInput = document.getElementById("qty");
  if (qtyInput) qtyInput.value = "1";

  const sel = items.find((i) => i.name === itemSelect.value);
  unitSelect.innerHTML = "";
  const placeholder = createOption("", "Select Unit");
  placeholder.disabled = true;
  placeholder.selected = true;
  unitSelect.appendChild(placeholder);
  price.value = "";
  if (!sel) {
    $('#unitSelect').trigger('change.select2');
    return;
  }
  for (let u in sel.units) {
    unitSelect.appendChild(createOption(u, u));
  }
  $('#unitSelect').trigger('change.select2');
};

function unitToKg(u) {
  u = u ? u.toLowerCase().trim() : "";
  if (u.endsWith("kg")) return parseFloat(u);
  if (u.endsWith("g")) return parseFloat(u) / 1000;
  return 0;
}
function unitToL(u) {
  u = u ? u.toLowerCase().trim() : "";
  if (u.endsWith("ml")) return parseFloat(u) / 1000;
  if (u.endsWith("l") && !u.endsWith("ml")) return parseFloat(u);
  return 0;
}

window.autoFillAndAdd = function () {
  const item = items.find((i) => i.name === itemSelect.value);
  if (!item) return;
  const unit = unitSelect.value, units = item.units;
  if (!unit) return;
  const baseUnit = Object.keys(units)[0], basePrice = units[baseUnit];
  const bKg = unitToKg(baseUnit), sKg = unitToKg(unit), bL = unitToL(baseUnit), sL = unitToL(unit);
  let p = 0;
  if (bKg > 0 && sKg > 0) p = (basePrice / bKg) * sKg;
  else if (bL > 0 && sL > 0) p = (basePrice / bL) * sL;
  else if (units[unit] != undefined) p = units[unit];
  price.value = p.toFixed(2);
  if (parseFloat(qty.value) > 0 && p > 0) addOrUpdate();
};

async function saveBillToHistory(paidAmount) {
  if (!currentUserId) throw new Error("Please sign in first.");

  const itemsSnapshot = billItems.map((it) => ({ ...it }));
  const cname = customerName.value.trim() || "Walk-in Customer";
  const subtotal = itemsSnapshot.reduce((sum, item) => sum + (parseFloat(item.total) || 0), 0);
  const taxPercent = parseFloat(tax.value) || 0;
  const discountPercent = parseFloat(discount.value) || 0;
  const taxAmount = subtotal * taxPercent / 100;
  const discountAmount = (subtotal + taxAmount) * discountPercent / 100;
  const finalTotal = subtotal + taxAmount - discountAmount;
  const now = new Date();
  const date = now.toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
  const isoDate = now.toISOString();

  const stockRef = doc(db, "users", currentUserId, "stockData", "info");
  const historyRef = doc(collection(db, "users", currentUserId, "history"));
  const currentBillRef = doc(db, "users", currentUserId, "currentBill", "bill");

  await runTransaction(db, async (transaction) => {
    const stockSnap = await transaction.get(stockRef);
    const currentStock = stockSnap.exists() ? stockSnap.data() : {};
    const { updated, updatedStock } = applyStockDeduction(currentStock, itemsSnapshot);

    if (updated) {
      transaction.set(stockRef, updatedStock);
    }

    transaction.set(historyRef, {
      customer: cname,
      customerWhatsapp: customerWhatsapp.value.trim(),
      customerCountryCode: customerCountryCode.value.trim() || "91",
      date,
      isoDate,
      createdAt: serverTimestamp(),
      items: itemsSnapshot,
      subtotal: subtotal.toFixed(2),
      taxPercent,
      discountPercent,
      total: finalTotal.toFixed(2),
      paidAmount,
      payments: [],
    });

    transaction.set(currentBillRef, {
      items: [],
      customerName: "",
      customerWhatsapp: "",
      customerCountryCode: "91",
      tax: 0,
      discount: 0,
    });
  });

  billItems = [];
  stockDeductedForCurrentBill = false;
  customerName.value = "";
  customerWhatsapp.value = "";
  customerCountryCode.value = "91";
  tax.value = "0";
  discount.value = "0";
  renderBill();
}

window.saveToHistory = async function () {
  if (billItems.length === 0) return alert("Add items to bill first.");
  const finalTotal = parseFloat(totalAmount.innerText) || 0;

  let paidStr = prompt(`Grand Total is Rs.${finalTotal.toFixed(2)}.\nEnter initial amount paid by customer:`, finalTotal);
  if (paidStr === null) return;
  let paidAmount = parseFloat(paidStr);
  if (isNaN(paidAmount) || paidAmount < 0) return alert("Please enter a valid positive amount!");
  if (paidAmount > finalTotal + 0.05) return alert("Paid amount cannot exceed the grand total!");

  try {
    await saveBillToHistory(paidAmount);
    alert("Bill saved successfully!");
  } catch (e) {
    alert("Error saving bill: " + e.message);
  }
};

window.toggleHistory = () => {
  const isShow = !historyContainer.classList.contains("active");
  if (isShow) {
    historyContainer.classList.add("active");
    pushSectionState("history");
  } else {
    historyContainer.classList.remove("active");
    window.openSectionsStack = window.openSectionsStack.filter(s => s !== "history");
    history.back();
  }
};

function renderBill() {
  billList.innerHTML = "";
  let sum = 0;
  if (billItems.length === 0) {
    billList.innerHTML = "<p style='color:var(--text-muted); font-style:italic; text-align:center; padding:15px;'>Bill is empty.</p>";
  }
  billItems.forEach((it, i) => {
    sum += it.total;
    billList.innerHTML += `
    <div class="item-row">
       <span style="font-weight:600; color:var(--text-main);">${escapeHTML(it.name)} <br> <span style="font-size:0.8rem; font-weight:normal; color:var(--text-muted);">(${escapeHTML(it.unit)} | Qty: ${escapeHTML(it.qty)} @ Rs.${escapeHTML(it.price)})</span></span>
       <div style="display:flex; align-items:center; gap:12px;">
         <span style="font-weight:700; color:var(--primary);">Rs.${it.total.toFixed(2)}</span>
         <button onclick="removeItem(${i})" class="remove-btn">x</button>
       </div>
    </div>`;
  });

  let taxVal = parseFloat(tax.value) || 0;
  if (taxVal < 0) taxVal = 0; if (taxVal > 100) taxVal = 100; tax.value = taxVal;

  let discVal = parseFloat(discount.value) || 0;
  if (discVal < 0) discVal = 0; if (discVal > 100) discVal = 100; discount.value = discVal;

  sum += (sum * taxVal) / 100;
  sum -= (sum * discVal) / 100;
  totalAmount.innerText = sum.toFixed(2);
}

tax.addEventListener("input", () => {
  renderBill();
  saveCurrentBill();
});
discount.addEventListener("input", () => {
  renderBill();
  saveCurrentBill();
});

window.savePDF = async function () {
  if (billItems.length === 0) return alert("Add items first.");
  const cname = customerName.value.trim() || "Walk-in Customer";
  let subtotal = billItems.reduce((sum, item) => sum + item.total, 0);
  let taxPercent = parseFloat(tax.value) || 0, discountPercent = parseFloat(discount.value) || 0;
  let taxAmount = subtotal * taxPercent / 100;
  let discountAmount = (subtotal + taxAmount) * discountPercent / 100;
  let grandTotal = subtotal + taxAmount - discountAmount;

  let paidStr = prompt(`Grand Total: Rs.${grandTotal.toFixed(2)}.\nEnter paid amount:`, grandTotal);
  if (paidStr === null) return;
  let paidAmt = parseFloat(paidStr);
  if (isNaN(paidAmt) || paidAmt < 0) return alert("Please enter a valid amount!");
  if (paidAmt > grandTotal + 0.05) return alert("Paid amount cannot exceed grand total!");

  let dueAmt = grandTotal - paidAmt;

  const now = new Date();
  const date = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const invoiceNo = "INV-" + Date.now().toString().slice(-6);

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();

  let y = 15;

  function drawHeader() {
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(20);
    pdf.text("EasyBill", 105, y, { align: "center" });
    y += 5;
    pdf.setFontSize(10); pdf.setFont("helvetica", "normal");
    y += 4;
    pdf.line(14, y, 196, y);
    y += 6;
    pdf.text(`Customer : ${cname}`, 14, y);
    pdf.text(`Invoice No: ${invoiceNo}`, 140, y);
    y += 6;
    pdf.text(`Date : ${date} ${time}`, 14, y);
    y += 4;
    pdf.line(14, y, 196, y);
    y += 8;

    pdf.setFont("helvetica", "bold");
    pdf.text("S.No", 14, y); pdf.text("Item", 30, y); pdf.text("Unit", 95, y); pdf.text("Qty", 125, y); pdf.text("Rate", 148, y); pdf.text("Total", 192, y, { align: "right" });
    y += 2;
    pdf.line(14, y, 196, y);
    y += 8;
    pdf.setFont("helvetica", "normal");
  }

  drawHeader();

  billItems.forEach((it, index) => {
    if (y > 275) {
      pdf.addPage();
      y = 20;
      drawHeader();
    }
    pdf.text(String(index + 1), 14, y);
    pdf.text(it.name.substring(0, 25), 30, y);
    pdf.text(it.unit, 95, y);
    pdf.text(String(it.qty), 125, y);
    pdf.text(`Rs.${it.price.toFixed(2)}`, 148, y);
    pdf.text(`Rs.${it.total.toFixed(2)}`, 192, y, { align: "right" });
    y += 7;
  });

  if (y > 250) {
    pdf.addPage();
    y = 20;
  }

  pdf.line(14, y, 196, y);
  y += 6;
  pdf.text("Subtotal :", 140, y); pdf.text(`Rs.${subtotal.toFixed(2)}`, 192, y, { align: "right" });
  y += 6;
  if (taxPercent > 0) { pdf.text(`GST (${taxPercent}%) :`, 140, y); pdf.text(`Rs.${taxAmount.toFixed(2)}`, 192, y, { align: "right" }); y += 6; }
  if (discountPercent > 0) { pdf.text(`Discount (${discountPercent}%) :`, 140, y); pdf.text(`- Rs.${discountAmount.toFixed(2)}`, 192, y, { align: "right" }); y += 6; }

  pdf.setFont("helvetica", "bold");
  pdf.text("GRAND TOTAL :", 130, y); pdf.text(`Rs. ${grandTotal.toFixed(2)}`, 192, y, { align: "right" });
  y += 6;
  pdf.text("Paid Amount :", 130, y); pdf.text(`Rs.${paidAmt.toFixed(2)}`, 192, y, { align: "right" });
  y += 6;
  pdf.text("Balance Due :", 130, y); pdf.text(`Rs.${dueAmt.toFixed(2)}`, 192, y, { align: "right" });

  pdf.save(`Bill_${cname}_${Date.now()}.pdf`);
};

window.shareBill = async function () {
  if (billItems.length === 0) return alert("Bill is empty!");
  const cname = customerName.value.trim() || "Customer";
  let wa = customerWhatsapp.value.trim();

  if (wa && !/^[0-9]{10}$/.test(wa)) {
    return alert("Please enter a valid 10-digit WhatsApp mobile number!");
  }

  let grandTotal = parseFloat(totalAmount.innerText) || 0;
  let paidStr = prompt(`Grand Total: Rs.${grandTotal.toFixed(2)}.\nEnter paid amount:`, grandTotal);
  if (paidStr === null) return;
  let paidAmt = parseFloat(paidStr);
  if (isNaN(paidAmt) || paidAmt < 0) return alert("Please enter a valid amount!");
  if (paidAmt > grandTotal + 0.05) return alert("Paid amount cannot exceed grand total!");

  let dueAmt = grandTotal - paidAmt;
  let txt = "```\n";
  txt += "   EasyBill RECEIPT\n";
  txt += `Name : ${cname}\n`;
  txt += "------------------------\n";
  txt += "Item         Qty      Total\n";
  txt += "------------------------\n";

  billItems.forEach((it) => {
    let name = it.name.length > 9 ? it.name.substring(0, 8) + "." : it.name;
    let qtyStrFormatted = `Qty:${it.qty}`;
    let tot = `Rs.${it.total.toFixed(0)}`;

    txt += `${name.padEnd(10, " ")} ${qtyStrFormatted.padEnd(9, " ")} ${tot}\n`;
  });

  txt += "------------------------\n";
  txt += `Total : Rs.${grandTotal.toFixed(2)}\n`;
  txt += `Paid  : Rs.${paidAmt.toFixed(2)}\n`;
  txt += `Due   : Rs.${dueAmt.toFixed(2)}\n`;
  txt += "------------------------\n";
  txt += "     Thank You! \n";
  txt += "```";

  if (wa) {
    let cc = (document.getElementById("customerCountryCode").value || "91").replace(/\D/g, "") || "91";
    window.open(`https://wa.me/${cc}${wa}?text=${encodeURIComponent(txt)}`, "_blank");
  } else if (navigator.share) {
    navigator.share({ title: "Bill", text: txt });
  } else {
    navigator.clipboard.writeText(txt);
    alert("Bill text copied to clipboard!");
  }
};

window.printBill = async function () {
  if (billItems.length === 0) return alert("Bill is empty!");
  let grandTotal = parseFloat(totalAmount.innerText) || 0;
  let paidStr = prompt(`Grand Total: Rs.${grandTotal.toFixed(2)}.\nEnter paid amount:`, grandTotal);
  if (paidStr === null) return;
  let paidAmt = parseFloat(paidStr);
  if (isNaN(paidAmt) || paidAmt < 0) return alert("Please enter a valid amount!");
  if (paidAmt > grandTotal + 0.05) return alert("Paid amount cannot exceed grand total!");

  let dueAmt = grandTotal - paidAmt;
  const cname = customerName.value.trim() || "Walk-in Customer";
  const wa = customerWhatsapp.value.trim();

  const now = new Date();
  const date = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const invoiceNo = "INV-" + Date.now().toString().slice(-6);

  let subtotal = billItems.reduce((sum, it) => sum + it.total, 0);
  let taxPercent = parseFloat(tax.value) || 0;
  let discountPercent = parseFloat(discount.value) || 0;
  let taxAmount = subtotal * taxPercent / 100;
  let discountAmount = (subtotal + taxAmount) * discountPercent / 100;

  let rowsHtml = billItems.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHTML(it.name)}</td>
      <td>${escapeHTML(it.unit)}</td>
      <td class="num">${escapeHTML(it.qty)}</td>
      <td class="num">Rs.${it.price.toFixed(2)}</td>
      <td class="num">Rs.${it.total.toFixed(2)}</td>
    </tr>`).join("");

  const printArea = document.getElementById("printArea");
  if (!printArea) {
    return alert("Print area not found in page. Make sure <div id=\"printArea\"></div> exists in index.html.");
  }

  printArea.innerHTML = `
    <div class="invoice-box">
      <div class="header">
        <h1>EasyBill</h1>
        <div class="meta">
          <div><b>Invoice No:</b> ${invoiceNo}</div>
          <div><b>Date:</b> ${date} ${time}</div>
        </div>
      </div>

      <div class="customer-info">
        <div><b>Billed To:</b><br>${escapeHTML(cname)}${wa ? `<br>+${escapeHTML(customerCountryCode.value.trim() || "91")} ${escapeHTML(wa)}` : ""}</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th><th>Item</th><th>Unit</th>
            <th class="num">Qty</th><th class="num">Rate</th><th class="num">Total</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <div class="totals">
        <div><span>Subtotal</span><span>Rs.${subtotal.toFixed(2)}</span></div>
        ${taxPercent > 0 ? `<div><span>GST (${taxPercent}%)</span><span>Rs.${taxAmount.toFixed(2)}</span></div>` : ""}
        ${discountPercent > 0 ? `<div><span>Discount (${discountPercent}%)</span><span>- Rs.${discountAmount.toFixed(2)}</span></div>` : ""}
        <div class="grand"><span>Grand Total</span><span>Rs.${grandTotal.toFixed(2)}</span></div>
        <div><span>Paid</span><span>Rs.${paidAmt.toFixed(2)}</span></div>
        <div><span>Due</span><span>Rs.${dueAmt.toFixed(2)}</span></div>
      </div>

      <div class="footer">Thank you for your business!</div>
    </div>`;

  // No popup, no loading delay — window.print() prints the current
  // page directly. The @media print rules in style.css hide
  // everything except #printArea.
  window.print();
};

window.toggleAddItemForm = () => {
  const isShow = !addNewItemForm.classList.contains("active");
  if (isShow) {
    addNewItemForm.classList.add("active");
    pushSectionState("addNewItem");
  } else {
    addNewItemForm.classList.remove("active");
    window.openSectionsStack = window.openSectionsStack.filter(s => s !== "addNewItem");
    history.back();
  }
};

document.getElementById("customerWhatsapp").addEventListener("input", function () {
  this.value = this.value.replace(/\D/g, "").slice(0, 10);
  saveCurrentBill();
});
document.getElementById("customerCountryCode").addEventListener("input", function () {
  this.value = this.value.replace(/\D/g, "").slice(0, 4);
  saveCurrentBill();
});
document.getElementById("customerName").addEventListener("input", saveCurrentBill);

$(document).ready(() => { $(".select2").select2({ width: "100%" }); });