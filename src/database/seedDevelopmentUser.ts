import { closeDatabasePool } from "./database.js";
import { getCurrentUserId } from "../services/developmentUserService.js";

try {
    const userId = await getCurrentUserId();
    console.log(`Usu\u00e1rio de desenvolvimento preparado (id: ${userId}).`);
} finally {
    await closeDatabasePool();
}
