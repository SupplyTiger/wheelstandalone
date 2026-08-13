export function isMissingPostgresSchemaError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const details = error as Record<string, unknown>;
  const code = String(details.code ?? "");
  const message = String(details.message ?? details.details ?? "");
  return code === "42P01" || code === "42704" || /relation .* does not exist|type .* does not exist/i.test(message);
}
