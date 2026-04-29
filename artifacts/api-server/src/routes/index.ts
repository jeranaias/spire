import { Router, type IRouter } from "express";
import healthRouter from "./health";
import unitsRouter from "./units";
import supplyRouter from "./supply";
import resupplyRouter from "./resupply";
import catalogRouter from "./catalog";
import dashboardRouter from "./dashboard";
import syncRouter from "./sync";
import weaponsRouter from "./weapons";
import historyRouter from "./history";
import spirePrRouter from "./spire-pr";

const router: IRouter = Router();

router.use(healthRouter);
router.use(unitsRouter);
router.use(supplyRouter);
router.use(resupplyRouter);
router.use(catalogRouter);
router.use(dashboardRouter);
router.use(syncRouter);
router.use(weaponsRouter);
router.use(historyRouter);
router.use(spirePrRouter);

export default router;
