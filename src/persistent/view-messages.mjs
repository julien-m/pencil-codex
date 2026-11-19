// Localized messages for explicit lifecycle controls; existing prototype copy is unchanged.
const catalogs = {
  en: {
    sessionClosed: 'Session closed', mode: 'View mode', zoom: 'Zoom',
    hand: 'Hand', edit: 'Edit', zoomOut: 'Zoom out', zoomIn: 'Zoom in',
    openNative: 'Open in Pencil', openHint: 'Save this document and open it in the Pencil desktop app',
    updateService: 'Update the Pencil background service to use this control.',
    opening: 'Saving and opening in Pencil…', opened: 'Open request sent to Pencil',
    launchFailed: 'Document saved. Could not open the Pencil desktop app.',
    nativeUnavailable: 'Opening in the desktop app requires macOS.',
    nativeSourceUnavailable: 'Download this .pen file in Finder, then try opening it again.',
    readHelp: 'Live Pencil canvas. Drag or use the arrow keys to pan. Use plus and minus to zoom.',
    editHelp: 'Live Pencil editor. Click to focus, then use the pointer or keyboard. Command or Control S saves the source document.',
  },
  fr: {
    sessionClosed: 'Session fermée', mode: 'Mode du panneau', zoom: 'Zoom',
    hand: 'Main', edit: 'Modifier', zoomOut: 'Zoom arrière', zoomIn: 'Zoom avant',
    openNative: 'Ouvrir dans Pencil', openHint: 'Enregistrer ce document et l’ouvrir dans l’application Pencil',
    updateService: 'Mettez à jour le service Pencil pour utiliser cette commande.',
    opening: 'Enregistrement et ouverture dans Pencil…', opened: 'Demande d’ouverture envoyée à Pencil',
    launchFailed: 'Document enregistré. Impossible d’ouvrir l’application Pencil.',
    nativeUnavailable: 'L’ouverture dans l’application nécessite macOS.',
    nativeSourceUnavailable: 'Téléchargez ce fichier .pen dans le Finder, puis réessayez de l’ouvrir.',
    readHelp: 'Canevas Pencil. Faites glisser ou utilisez les flèches pour vous déplacer. Utilisez plus et moins pour zoomer.',
    editHelp: 'Éditeur Pencil. Cliquez pour prendre le focus, puis utilisez le pointeur ou le clavier. Commande ou Contrôle S enregistre le document.',
  },
};
/** Resolve the configured document language with an English fallback. */
export function viewMessage(key, language = 'en') {
  const locale = language.split('-')[0];
  return (Object.hasOwn(catalogs, locale) ? catalogs[locale] : catalogs.en)[key];
}
