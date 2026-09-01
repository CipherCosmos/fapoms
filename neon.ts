import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  preview: {
    buckets: {
      fapoms: { access: "private" },
    },
  },
});
