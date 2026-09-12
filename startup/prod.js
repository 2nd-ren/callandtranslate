import compression from "compression";

export default function (app) {
  app.use(compression());
}
