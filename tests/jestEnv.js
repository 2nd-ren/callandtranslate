process.env.NODE_ENV = "test";
delete process.env.callandtranslate_jwtPrivateKey;
delete process.env.showdoclive_jwtPrivateKey;
delete process.env.liveproductiondoc_jwtPrivateKey;
process.env.INTERNAL_API_SECRET =
  process.env.INTERNAL_API_SECRET || "test-internal-secret";
delete process.env.XAI_API_KEY;

import { readFileSync, existsSync } from "fs";

function testMongoUri() {
  if (process.env.TEST_MONGO_URI) return process.env.TEST_MONGO_URI;
  const envPaths = [
    "/etc/callandtranslate.env",
    "/etc/showdoclive.env",
    "/etc/eventbrieflive.env",
  ];
  const envPath = envPaths.find((p) => existsSync(p));
  if (!envPath) return null;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    if (line.startsWith("callandtranslatedb=")) {
      return line
        .slice("callandtranslatedb=".length)
        .replace("/callandtranslatedb", "/callandtranslate_tests");
    }
    if (line.startsWith("showdoclivedb=")) {
      return line
        .slice("showdoclivedb=".length)
        .replace("/showdoclivedb", "/callandtranslate_tests");
    }
    if (line.startsWith("eventbrieflivedb=")) {
      return line
        .slice("eventbrieflivedb=".length)
        .replace("/eventbrieflivedb", "/callandtranslate_tests")
        .replace("/eventbrieflive_tests", "/callandtranslate_tests");
    }
  }
  return null;
}

const uri = testMongoUri();
if (uri) {
  process.env.callandtranslatedb = uri;
}
