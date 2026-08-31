// Keep versioned requests intact; only replace the address shown to the user.
export function cleanPublicUrl({ location = window.location, history = window.history } = {}){
  const publicUrl = new URL('./', location.href);
  publicUrl.search = location.search;
  publicUrl.searchParams.delete('v');
  publicUrl.hash = location.hash;
  history.replaceState(history.state, '', publicUrl.href);
}
