import "dotenv/config";
import express from "express";
import path from "node:path";
import bulaRoutes from "./routes/bulaRoutes.js";
import medicationRoutes from "./routes/medicationRoutes.js";

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
});

app.use("/api/bula", bulaRoutes);
app.use("/api/medications", medicationRoutes);

app.listen(port, () => {
    console.log(`MediBot API em execução na porta ${port}.`);
});
