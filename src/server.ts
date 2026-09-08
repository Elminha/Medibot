import "dotenv/config";
import express from "express";
import bulaRoutes from "./routes/bulaRoutes.js";

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());

app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
});

app.use("/api/bula", bulaRoutes);

app.listen(port, () => {
    console.log(`MediBot API em execução na porta ${port}.`);
});
