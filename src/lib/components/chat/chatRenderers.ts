// Resolve each optional renderer once, before committing history that needs it.
let loaded: typeof import('./ChatRichContent') | undefined;
export const getChatRichContent = () => loaded?.ChatRichContent;
let rich: Promise<typeof import('./ChatRichContent')> | undefined;
export function loadChatRichContent() {
  return rich ??= import('./ChatRichContent').then(module => { loaded = module; return module; }).catch(error => { rich = undefined; throw error; });
}
