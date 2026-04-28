import { Router, type IRouter } from "express";
import healthRouter from "./health";
import unitsRouter from "./units";
import supplyRouter from "./supply";
import resupplyRouter from "./resupply";
import catalogRouter from "./catalog";
import dashboardRouter from "./dashboard";
import syncRouter from "./sync";

const router: IRouter = Router();

router.use(healthRouter);
router.use(unitsRouter);
router.use(supplyRouter);
router.use(resupplyRouter);
router.use(catalogRouter);
router.use(dashboardRouter);
router.use(syncRouter);

export default router;
