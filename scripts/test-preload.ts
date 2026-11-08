import { usePostgresForTests } from "../src/testing.ts";

// A run without ROUNDTABLE_TEST_DATABASE_URL gets its own throwaway PostgreSQL, so the database
// suites run locally instead of skipping. CI sets the variable and the helper adopts its service.
await usePostgresForTests();
