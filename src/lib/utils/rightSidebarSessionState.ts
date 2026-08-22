export function shouldClearSessionFilePreview(
  previewContextKey: string,
  sidebarContextKey: string | null,
  selectedFilePath: string | null,
): boolean {
  return Boolean(
    previewContextKey
    && sidebarContextKey === previewContextKey
    && !selectedFilePath,
  );
}
