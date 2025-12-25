const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const ExcelJS = require("exceljs");
const path = require("path");

// load .env for local development (ignored in git)
if (process.env.NODE_ENV !== "production") {
  try {
    const dotenv = require("dotenv");
    dotenv.config({ path: path.resolve(__dirname, ".env") });
    dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
  } catch (e) {
    /* ignore if dotenv not installed or no .env present */
  }
}

// Initialize Firebase with credentials from env (safe parse, only once)
if (!admin.apps || admin.apps.length === 0) {
  if (process.env.FIREBASE_CONFIG) {
    try {
      const cfg = typeof process.env.FIREBASE_CONFIG === "string"
        ? JSON.parse(process.env.FIREBASE_CONFIG)
        : process.env.FIREBASE_CONFIG;
      admin.initializeApp({ credential: admin.credential.cert(cfg) });
    } catch (err) {
      console.error("Failed to parse FIREBASE_CONFIG, falling back to default init:", err.message);
      admin.initializeApp();
    }
  } else {
    admin.initializeApp();
  }
}

const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

/* ---------------- HEALTH ---------------- */

app.get("/", (_, res) => {
  res.send("API running");
});

/* ---------------- GET PRODUCTS ---------------- */

app.get("/products", async (req, res) => {
  try {
    const snap = await db
      .collection("products")
      .get();

    const data = snap.docs.map((d) => ({
      id: d.id,
      ...d.data()
    }));

    console.log("Fetched products:", data.length);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New: Get single product
app.get("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await db.collection("products").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "Product not found" });
    res.json({ id: snap.id, ...snap.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- CREATE PRODUCT ---------------- */

app.post("/products", async (req, res) => {
  try {
    const { itemCode, description = "", unit = "", price = 0 } = req.body;
    if (!itemCode) return res.status(400).json({ error: "itemCode required" });

    const docRef = db.collection("products").doc(itemCode);
    await docRef.set({ itemCode, description, unit, price: Number(price) });
    const snap = await docRef.get();
    res.status(201).json({ id: snap.id, ...snap.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- UPDATE PRODUCT (partial) ---------------- */

app.put("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    const allowed = ["itemCode", "description", "unit", "price"];
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = k === "price" ? Number(req.body[k]) : req.body[k];
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const docRef = db.collection("products").doc(id);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Product not found" });

    await docRef.set(updates, { merge: true });
    const updated = await docRef.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- DELETE PRODUCT ---------------- */

app.delete("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection("products").doc(id);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Product not found" });
    await docRef.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- DOWNLOAD BILL ---------------- */

app.post("/bill/download", async (req, res) => {
  try {
    const { items, meta = {} } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: "Items required" });
    }

    let grandTotal = 0;
    const billItems = [];

    for (const i of items) {
      const snap = await db.collection("products").doc(i.itemCode).get();
      if (!snap.exists) continue;
      const p = snap.data();
      const qty = Number(i.qty) || 0;
      const total = +(qty * (Number(p.price) || 0));
      billItems.push({
        itemCode: p.itemCode || snap.id,
        description: p.description || "",
        unit: p.unit || "",
        price: Number(p.price) || 0,
        quantity: qty,
        total
      });
      grandTotal += total;
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = process.env.SHOP_NAME || "Construction Cart";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Bill");

    const shopName = meta.shopName || process.env.SHOP_NAME || "Construction Cart";
    const invoiceNo = meta.invoiceNo || "";
    const customer = meta.customer || "";
    const dateStr = meta.date || new Date().toLocaleDateString();
    const currencySymbol = process.env.CURRENCY_SYMBOL || "₹";

    sheet.mergeCells("A1:G1");
    sheet.getCell("A1").value = shopName;
    sheet.getCell("A1").font = { size: 14, bold: true };
    sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };

    sheet.addRow([]);
    const metaRow = sheet.addRow(["Invoice No:", invoiceNo, "", "Customer:", customer, "", "Date:", dateStr]);
    sheet.addRow([]);

    sheet.columns = [
      { header: "S.No", key: "sno", width: 6 },
      { header: "Item Code", key: "itemCode", width: 18 },
      { header: "Description", key: "description", width: 40 },
      { header: "Unit", key: "unit", width: 10 },
      { header: "Price", key: "price", width: 12 },
      { header: "Quantity", key: "quantity", width: 10 },
      { header: "Total", key: "total", width: 14 }
    ];

    sheet.getRow(sheet.rowCount + 1).font = { bold: true };

    billItems.forEach((it, idx) => {
      sheet.addRow({
        sno: idx + 1,
        itemCode: it.itemCode,
        description: it.description,
        unit: it.unit,
        price: it.price,
        quantity: it.quantity,
        total: it.total
      });
    });

    sheet.addRow([]);
    const totalRow = sheet.addRow({ description: "GRAND TOTAL", total: grandTotal });
    totalRow.getCell("G").font = { bold: true };
    totalRow.getCell("G").numFmt = `"${currencySymbol}"#,##0.00`;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 4) {
        const priceCell = row.getCell(5);
        const totalCell = row.getCell(7);
        if (priceCell && typeof priceCell.value === "number") priceCell.numFmt = `"${currencySymbol}"#,##0.00`;
        if (totalCell && typeof totalCell.value === "number") totalCell.numFmt = `"${currencySymbol}"#,##0.00`;
      }
    });

    // Header styling
    const headerRowIndex = sheet._rows.findIndex((r) => r && r.values && r.values.includes("S.No"));
    if (headerRowIndex > 0) {
      const headerRow = sheet.getRow(headerRowIndex);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true };
        cell.border = {
          top: { style: "thin" },
          left: { style: "thin" },
          bottom: { style: "thin" },
          right: { style: "thin" }
        };
      });
    }

    // Write workbook to buffer and send as attachment
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    const filename = (meta.invoiceNo ? `bill_${meta.invoiceNo}.xlsx` : "bill.xlsx");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Mount and start server for Railway / local runs ---
// mount existing app under /api so Railway URL /api/* works
const serverApp = express();
serverApp.use(cors({ origin: true }));
serverApp.use(express.json());
serverApp.use("/api", app);

// start listening when run directly (Railway runs node functions/index.js)
if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 3000;
  serverApp.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  // handle termination signals gracefully
  const shutdown = (sig) => {
    console.log("Received", sig, "shutting down");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// export for Firebase Functions (keeps existing behavior)
exports.api = onRequest({ maxInstances: 10 }, serverApp);
