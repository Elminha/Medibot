import "dotenv/config";
import express from "express";
import path from "node:path";
import bulaRoutes from "./routes/bulaRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import medicationRoutes from "./routes/medicationRoutes.js";
import queryHistoryRoutes from "./routes/queryHistoryRoutes.js";
import reminderRoutes from "./routes/reminderRoutes.js";
import telegramRoutes from "./routes/telegramRoutes.js";

const app = express();
const port = Number(process.env.PORT) || 3000;

// Confia em exatamente 1 proxy (a borda da Vercel). A Vercel sobrescreve X-Forwarded-For
// com o IP real do cliente e não repassa IPs externos, então não há risco de spoofing.
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
});

app.use("/api/bula", bulaRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/medications", medicationRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/queries", queryHistoryRoutes);
app.use("/api/telegram", telegramRoutes);

if (!process.env.VERCEL) {
    app.listen(port, () => {
        console.log(`MediBot API em execução na porta ${port}.`);
    });
}

export default app;
