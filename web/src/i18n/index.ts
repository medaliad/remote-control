// Lightweight i18n for the embedded Remote-Access app.
//
// Locale comes from (in order of priority):
//   1. A `set-locale` postMessage from the host page (live switches).
//   2. The `?lang=` / `?locale=` query param in the iframe URL.
//   3. The `lang` localStorage entry from a previous session.
//   4. `navigator.language`.
//   5. Fallback: 'en'.
//
// Supported languages mirror VE Admin: en, fr, de.

import { useEffect, useState } from "react";

export type Locale = "en" | "fr" | "de";
export const SUPPORTED: Locale[] = ["en", "fr", "de"];
export const DEFAULT_LOCALE: Locale = "en";

const LS_KEY = "remoteAccess.locale";

function normalize(raw: string | null | undefined): Locale | null {
  if (!raw) return null;
  const code = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED as string[]).includes(code) ? (code as Locale) : null;
}

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  // 1. URL query (the page is loaded as `…/#/host?embed=1&lang=fr`,
  //    so the lang param sits inside the hash, not window.location.search).
  const hash = window.location.hash || "";
  const queryStr = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const qs = new URLSearchParams(queryStr);
  const fromUrl = normalize(qs.get("lang") || qs.get("locale"));
  if (fromUrl) return fromUrl;
  // 2. localStorage
  try {
    const fromLs = normalize(window.localStorage.getItem(LS_KEY));
    if (fromLs) return fromLs;
  } catch {
    /* storage blocked */
  }
  // 3. navigator
  const fromNav = normalize(navigator.language);
  if (fromNav) return fromNav;
  return DEFAULT_LOCALE;
}

// ─── Translation strings ────────────────────────────────────────────────

type Dict = Record<string, string>;

const en: Dict = {
  // App / nav
  "nav.brand": "Remote Access",
  "nav.tagline": "Peer · Secure · Instant",
  "nav.host": "Host",
  "nav.join": "Join",
  "nav.badge": "Approval-first screen sharing",

  // Home
  "home.title": "Remote Access",
  "home.titleSub": "with a click, not a backdoor.",
  "home.intro":
    "Share your screen with someone you trust, with an explicit approval step on every connection. No auto-accept, no background sharing — nothing happens without your click.",
  "home.host.title": "Share my screen (Host)",
  "home.host.desc":
    "Generate a one-time code. A client must enter it and you must approve their request before anything starts.",
  "home.client.title": "View a shared screen (Client)",
  "home.client.desc":
    "Enter the code the host gave you. You'll see “waiting for approval” until they accept — then the screen appears.",
  "home.privacy.label": "Privacy:",
  "home.privacy.body":
    "Your screen is shared directly with the viewer. The server only handles the initial connection setup — your screen contents are never stored or sent through it.",

  // Host – idle
  "host.idle.title": "Share your screen",
  "host.idle.intro":
    "Create a session and we'll give you a short code to share. Every connection request will require your explicit approval.",
  "host.idle.nameLabel": "Your display name (optional)",
  "host.idle.create": "Create session",
  "host.idle.preparing": "Preparing session…",
  "host.idle.sessionEnded": "Session ended.",

  // Host – creating
  "host.creating.label": "Creating…",
  "host.creating.title": "Setting up your session",
  "host.creating.subtitle": "Connecting to the server…",

  // Host – waiting
  "host.waiting.statusPill": "Session created — waiting for a request",
  "host.waiting.title": "Waiting for a request",
  "host.waiting.intro":
    "Share this code with the person who wants to view your screen.",
  "host.waiting.codeLabel": "Session code",
  "host.waiting.copyCode": "Copy code",
  "host.waiting.copyLink": "Copy share link",
  "host.waiting.linkShort": "Link",
  "host.waiting.shieldHead": "Nothing is shared until you approve.",
  "host.waiting.shieldBody":
    "When they enter the code, you'll see their request here and can approve or reject it.",

  // Host – request
  "host.request.statusPill": "Incoming request from {name}",
  "host.request.title": "Incoming connection request",
  "host.request.intro":
    "{name} is asking to view your screen on session {code}. You can approve or reject.",
  "host.request.requestingMeta": "requesting access · session {code}",
  "host.request.helper":
    "Approving will prompt you to pick a screen or window to share — you can cancel at that step too.",
  "host.request.approve": "Approve & share",
  "host.request.reject": "Reject",

  // Host – connecting
  "host.connecting.statusPill": "Connecting…",
  "host.connecting.title": "Connecting…",
  "host.connecting.intro": "Please pick the screen or window you want to share.",

  // Host – connected (header / panels)
  "host.connected.statusPill": "Connected to {name}",
  "host.connected.endSession": "End session",
  "host.connected.micOn": "Mic on",
  "host.connected.micOff": "Mic off",
  "host.connected.micToggleOn": "Turn microphone on",
  "host.connected.micToggleOff": "Turn microphone off",
  "host.connected.hideInfo": "Hide info",
  "host.connected.showInfo": "Info",
  "host.connected.hideInfoTitle": "Hide info panel",
  "host.connected.showInfoTitle": "Show info panel",
  "host.connected.livePreview": "Live preview",
  "host.connected.previewBlurb":
    "This is the preview of what {name} is seeing. You can stop at any time by clicking “End session” above or using your browser's native “Stop sharing” control.",
  "host.connected.session": "Session",
  "host.connected.remoteInput": "Remote input",
  "host.connected.remoteInputBlurb":
    "Auto-enabled on approve. Flip OFF as a kill-switch (cursor stops responding instantly).",
  "host.connected.localAgent": "Local mouse agent",
  "host.connected.agent.up": "Ready",
  "host.connected.agent.warming": "Warming",
  "host.connected.agent.connecting": "Connecting",
  "host.connected.agent.down": "Offline",
  "host.connected.agent.off": "Idle",
  "host.connected.agent.upBlurb": "Mouse events are being injected",
  "host.connected.agent.upBlurbVia": " via {backend}.",
  "host.connected.agent.warmingBlurb":
    "Agent connected, backend warming up. PowerShell is loading the Win32 wrapper — usually less than a second.",
  "host.connected.agent.warmingBlurbVb6":
    "Agent connected, backend warming up. Start MouseControl.exe — should attach within a second.",
  "host.connected.agent.connectingBlurb": "Connecting to local agent…",
  "host.connected.agent.downBlurb":
    "Can't reach the local agent. Run `npm start` inside agent/.",
  "host.connected.agent.offBlurb": "Toggle on to enable remote input control.",
  "host.connected.recentEvents": "Recent events",
  "host.connected.noEvents": "No input received.",

  // Host – warnings
  "host.micUnavailable": "Microphone unavailable",
  "host.micUnavailable.body":
    "Couldn't access the microphone. Check browser permissions.",
  "host.dismiss": "Dismiss",
  "host.warn.cursorOffline":
    "Remote cursor will not move — local agent is offline.",
  "host.warn.starting":
    "Starting local agent… your cursor will respond in a moment.",
  "host.warn.connecting": "Connecting to local agent…",
  "host.warn.notStarted": "Local agent not started.",
  "host.warn.fixIntro":
    "The local helper isn't reachable on this PC. Two things to check:",
  "host.warn.fix1":
    "This page must be open on the same computer you want controlled. The helper only works locally — it cannot be reached from another machine.",
  "host.warn.fix2.before": "Install or restart the helper: open the ",
  "host.warn.fix2.after":
    " folder on this PC and double-click Setup.cmd. If it's already installed, run Diagnose.cmd for a one-screen status check.",

  // Host – disconnect reasons
  "host.dc.serverUnreachable": "Could not reach the server.",
  "host.dc.connectionClosed": "The connection was closed.",
  "host.dc.shareCancelled": "Screen share was cancelled.",
  "host.dc.youStopped": "You stopped sharing your screen.",
  "host.dc.youEnded": "You ended the session.",
  "host.dc.connClosed": "Connection closed: {reason}",
  "host.event.clientLeft": "client left ({reason})",
  "host.event.error": "error: {message}",

  // Client – idle
  "client.idle.title": "Join a session",
  "client.idle.intro":
    "Ask the host for their session code. The host has to approve your request before anything is shared.",
  "client.idle.nameLabel": "Your display name",
  "client.idle.namePlaceholder": "How should the host know you?",
  "client.idle.codeLabel": "Session code",
  "client.idle.send": "Send connection request",
  "client.idle.connecting": "Connecting…",

  // Client – status / errors
  "client.sessionEnded": "Session ended.",
  "client.requestRejected": "Request rejected.",
  "client.dc.serverUnreachable": "Could not reach the server.",
  "client.dc.connectionClosed": "The connection was closed.",
  "client.dc.cancelled": "You cancelled the request.",
  "client.dc.disconnected": "You disconnected.",
  "client.dc.hostLeft": "Host left: {reason}",
  "client.dc.invalidCode": "That code isn't valid. Ask the host for a new one.",
  "client.dc.sessionFull": "The host already has another viewer connected.",
  "client.dc.sessionEndedEarly":
    "The host ended the session before you joined.",
  "client.dc.hostRejected": "The host rejected your request.",
  "client.dc.connClosed": "Connection closed: {reason}",

  // Client – requesting / waiting
  "client.requesting.statusPill": "Sending request…",
  "client.requesting.title": "Requesting connection",
  "client.requesting.intro": "Connecting with code {code}.",
  "client.waiting.statusPill": "Waiting for approval",
  "client.waiting.title": "Waiting for the host",
  "client.waiting.intro":
    "Your request reached the host. You'll see their screen as soon as they approve. Feel free to cancel if you've changed your mind.",
  "client.waiting.shield":
    "Tell the host to look for {name} in their request list on session {code}.",
  "client.waiting.cancel": "Cancel request",

  // Client – connecting
  "client.connecting.statusPill": "Approved — connecting…",
  "client.connecting.title": "Connecting to {code}",
  "client.connecting.intro":
    "Establishing the connection. This usually takes a second or two.",
  "client.connecting.cancel": "Cancel",

  // Client – connected
  "client.connected.statusPill": "Connected to {code}",
  "client.connected.controlOn": "Remote control on",
  "client.connected.controlShort": "Control",
  "client.connected.controlTitle": "The host has granted you remote input.",
  "client.connected.unmute": "Unmute",
  "client.connected.mute": "Mute",
  "client.connected.unmuteTitle": "Unmute shared audio",
  "client.connected.muteTitle": "Mute shared audio",
  "client.connected.fullscreen": "Fullscreen",
  "client.connected.exitFullscreen": "Exit fullscreen",
  "client.connected.exitFullscreenTitle": "Exit fullscreen (Esc)",
  "client.connected.disconnect": "Disconnect",
  "client.connected.disconnectTitle": "Disconnect from the session",
  "client.connected.streaming": "Streaming",
  "client.connected.controlBlurb":
    "Remote control is on — your clicks and keys are being forwarded to the host.",
  "client.connected.viewBlurb":
    "View-only. The host controls whether your input is forwarded.",
  "client.connected.session": "Session",
  "client.connected.inputStatus": "Input status",
  "client.connected.inputAllowed":
    "The host has allowed your input. Click the video area to focus it, then interact as you would locally.",
  "client.connected.inputBlocked":
    "The host hasn't enabled remote control. You can watch, but your clicks and keys stay on this page.",
  "client.connected.tips": "Tips",
  "client.connected.tipsBody":
    "If the video looks blurry, try resizing the window — the host's screen is scaled to fit. Click the video to focus it before typing, so keys route to the host. Audio plays if the host ticked “Share audio” in the browser picker.",
};

const fr: Dict = {
  "nav.brand": "Accès distant",
  "nav.tagline": "Pair · Sécurisé · Instantané",
  "nav.host": "Hôte",
  "nav.join": "Rejoindre",
  "nav.badge": "Partage d'écran avec approbation préalable",

  "home.title": "Accès distant",
  "home.titleSub": "en un clic, sans porte dérobée.",
  "home.intro":
    "Partagez votre écran avec une personne de confiance, avec une étape d'approbation explicite à chaque connexion. Pas d'acceptation automatique, pas de partage en arrière-plan — rien ne se passe sans votre clic.",
  "home.host.title": "Partager mon écran (Hôte)",
  "home.host.desc":
    "Générez un code à usage unique. Un client doit le saisir et vous devez approuver sa demande avant que quoi que ce soit ne démarre.",
  "home.client.title": "Voir un écran partagé (Client)",
  "home.client.desc":
    "Saisissez le code que l'hôte vous a fourni. Vous verrez « en attente d'approbation » jusqu'à ce qu'il accepte — l'écran apparaîtra alors.",
  "home.privacy.label": "Confidentialité :",
  "home.privacy.body":
    "Votre écran est partagé directement avec le spectateur. Le serveur ne gère que la mise en relation initiale — son contenu n'est jamais stocké ni transmis par celui-ci.",

  "host.idle.title": "Partagez votre écran",
  "host.idle.intro":
    "Créez une session et nous vous fournirons un court code à partager. Chaque demande de connexion nécessitera votre approbation explicite.",
  "host.idle.nameLabel": "Votre nom affiché (facultatif)",
  "host.idle.create": "Créer la session",
  "host.idle.preparing": "Préparation de la session…",
  "host.idle.sessionEnded": "Session terminée.",

  "host.creating.label": "Création…",
  "host.creating.title": "Configuration de votre session",
  "host.creating.subtitle": "Connexion au serveur…",

  "host.waiting.statusPill": "Session créée — en attente d'une demande",
  "host.waiting.title": "En attente d'une demande",
  "host.waiting.intro":
    "Partagez ce code avec la personne qui souhaite voir votre écran.",
  "host.waiting.codeLabel": "Code de session",
  "host.waiting.copyCode": "Copier le code",
  "host.waiting.copyLink": "Copier le lien",
  "host.waiting.linkShort": "Lien",
  "host.waiting.shieldHead": "Rien n'est partagé tant que vous n'avez pas approuvé.",
  "host.waiting.shieldBody":
    "Lorsqu'ils saisiront le code, leur demande apparaîtra ici et vous pourrez l'accepter ou la refuser.",

  "host.request.statusPill": "Demande entrante de {name}",
  "host.request.title": "Demande de connexion entrante",
  "host.request.intro":
    "{name} demande à voir votre écran sur la session {code}. Vous pouvez accepter ou refuser.",
  "host.request.requestingMeta": "demande l'accès · session {code}",
  "host.request.helper":
    "L'approbation vous invitera à choisir un écran ou une fenêtre à partager — vous pourrez aussi annuler à cette étape.",
  "host.request.approve": "Approuver et partager",
  "host.request.reject": "Refuser",

  "host.connecting.statusPill": "Connexion en cours…",
  "host.connecting.title": "Connexion en cours…",
  "host.connecting.intro":
    "Veuillez choisir l'écran ou la fenêtre que vous souhaitez partager.",

  "host.connected.statusPill": "Connecté à {name}",
  "host.connected.endSession": "Terminer la session",
  "host.connected.micOn": "Micro activé",
  "host.connected.micOff": "Micro coupé",
  "host.connected.micToggleOn": "Activer le microphone",
  "host.connected.micToggleOff": "Désactiver le microphone",
  "host.connected.hideInfo": "Masquer infos",
  "host.connected.showInfo": "Infos",
  "host.connected.hideInfoTitle": "Masquer le panneau d'informations",
  "host.connected.showInfoTitle": "Afficher le panneau d'informations",
  "host.connected.livePreview": "Aperçu en direct",
  "host.connected.previewBlurb":
    "Voici l'aperçu de ce que {name} voit. Vous pouvez arrêter à tout moment en cliquant sur « Terminer la session » ci-dessus ou via le bouton natif « Arrêter le partage » du navigateur.",
  "host.connected.session": "Session",
  "host.connected.remoteInput": "Saisie à distance",
  "host.connected.remoteInputBlurb":
    "Activée automatiquement à l'approbation. Désactivez-la comme coupe-circuit (le curseur cesse de répondre instantanément).",
  "host.connected.localAgent": "Agent souris local",
  "host.connected.agent.up": "Prêt",
  "host.connected.agent.warming": "Préchauffe",
  "host.connected.agent.connecting": "Connexion",
  "host.connected.agent.down": "Hors ligne",
  "host.connected.agent.off": "Inactif",
  "host.connected.agent.upBlurb": "Les événements souris sont injectés",
  "host.connected.agent.upBlurbVia": " via {backend}.",
  "host.connected.agent.warmingBlurb":
    "Agent connecté, backend en cours de préchauffe. PowerShell charge le wrapper Win32 — généralement moins d'une seconde.",
  "host.connected.agent.warmingBlurbVb6":
    "Agent connecté, backend en cours de préchauffe. Lancez MouseControl.exe — il devrait s'attacher en moins d'une seconde.",
  "host.connected.agent.connectingBlurb": "Connexion à l'agent local…",
  "host.connected.agent.downBlurb":
    "Impossible de joindre l'agent local. Exécutez `npm start` dans agent/.",
  "host.connected.agent.offBlurb":
    "Activez pour autoriser le contrôle à distance.",
  "host.connected.recentEvents": "Événements récents",
  "host.connected.noEvents": "Aucune saisie reçue.",

  "host.micUnavailable": "Microphone indisponible",
  "host.micUnavailable.body":
    "Impossible d'accéder au microphone. Vérifiez les permissions du navigateur.",
  "host.dismiss": "Fermer",
  "host.warn.cursorOffline":
    "Le curseur distant ne bougera pas — l'agent local est hors ligne.",
  "host.warn.starting":
    "Démarrage de l'agent local… votre curseur répondra dans un instant.",
  "host.warn.connecting": "Connexion à l'agent local…",
  "host.warn.notStarted": "Agent local non démarré.",
  "host.warn.fixIntro":
    "L'assistant local n'est pas joignable sur ce PC. Deux choses à vérifier :",
  "host.warn.fix1":
    "Cette page doit être ouverte sur le même ordinateur que celui à contrôler. L'assistant fonctionne uniquement localement — il n'est pas accessible depuis une autre machine.",
  "host.warn.fix2.before": "Installez ou redémarrez l'assistant : ouvrez le dossier ",
  "host.warn.fix2.after":
    " sur ce PC et double-cliquez sur Setup.cmd. S'il est déjà installé, lancez Diagnose.cmd pour un état d'une page.",

  "host.dc.serverUnreachable": "Impossible de joindre le serveur.",
  "host.dc.connectionClosed": "La connexion a été fermée.",
  "host.dc.shareCancelled": "Le partage d'écran a été annulé.",
  "host.dc.youStopped": "Vous avez arrêté de partager votre écran.",
  "host.dc.youEnded": "Vous avez terminé la session.",
  "host.dc.connClosed": "Connexion fermée : {reason}",
  "host.event.clientLeft": "client parti ({reason})",
  "host.event.error": "erreur : {message}",

  "client.idle.title": "Rejoindre une session",
  "client.idle.intro":
    "Demandez à l'hôte son code de session. L'hôte doit approuver votre demande avant tout partage.",
  "client.idle.nameLabel": "Votre nom affiché",
  "client.idle.namePlaceholder": "Comment l'hôte vous reconnaîtra-t-il ?",
  "client.idle.codeLabel": "Code de session",
  "client.idle.send": "Envoyer la demande",
  "client.idle.connecting": "Connexion…",

  "client.sessionEnded": "Session terminée.",
  "client.requestRejected": "Demande refusée.",
  "client.dc.serverUnreachable": "Impossible de joindre le serveur.",
  "client.dc.connectionClosed": "La connexion a été fermée.",
  "client.dc.cancelled": "Vous avez annulé la demande.",
  "client.dc.disconnected": "Vous vous êtes déconnecté.",
  "client.dc.hostLeft": "L'hôte est parti : {reason}",
  "client.dc.invalidCode": "Ce code n'est pas valide. Demandez-en un nouveau à l'hôte.",
  "client.dc.sessionFull": "L'hôte est déjà connecté à un autre spectateur.",
  "client.dc.sessionEndedEarly":
    "L'hôte a terminé la session avant que vous ne la rejoigniez.",
  "client.dc.hostRejected": "L'hôte a refusé votre demande.",
  "client.dc.connClosed": "Connexion fermée : {reason}",

  "client.requesting.statusPill": "Envoi de la demande…",
  "client.requesting.title": "Demande de connexion en cours",
  "client.requesting.intro": "Connexion avec le code {code}.",
  "client.waiting.statusPill": "En attente d'approbation",
  "client.waiting.title": "En attente de l'hôte",
  "client.waiting.intro":
    "Votre demande a été reçue par l'hôte. Vous verrez son écran dès qu'il aura accepté. N'hésitez pas à annuler si vous changez d'avis.",
  "client.waiting.shield":
    "Demandez à l'hôte de chercher {name} dans sa liste de demandes pour la session {code}.",
  "client.waiting.cancel": "Annuler la demande",

  "client.connecting.statusPill": "Approuvée — connexion…",
  "client.connecting.title": "Connexion à {code}",
  "client.connecting.intro":
    "Établissement de la connexion. Cela prend généralement une à deux secondes.",
  "client.connecting.cancel": "Annuler",

  "client.connected.statusPill": "Connecté à {code}",
  "client.connected.controlOn": "Contrôle à distance activé",
  "client.connected.controlShort": "Contrôle",
  "client.connected.controlTitle":
    "L'hôte vous a accordé la saisie à distance.",
  "client.connected.unmute": "Activer le son",
  "client.connected.mute": "Couper le son",
  "client.connected.unmuteTitle": "Activer l'audio partagé",
  "client.connected.muteTitle": "Couper l'audio partagé",
  "client.connected.fullscreen": "Plein écran",
  "client.connected.exitFullscreen": "Quitter le plein écran",
  "client.connected.exitFullscreenTitle": "Quitter le plein écran (Échap)",
  "client.connected.disconnect": "Se déconnecter",
  "client.connected.disconnectTitle": "Se déconnecter de la session",
  "client.connected.streaming": "Diffusion",
  "client.connected.controlBlurb":
    "Le contrôle à distance est activé — vos clics et frappes sont transmis à l'hôte.",
  "client.connected.viewBlurb":
    "Lecture seule. L'hôte décide si votre saisie est transmise.",
  "client.connected.session": "Session",
  "client.connected.inputStatus": "État de la saisie",
  "client.connected.inputAllowed":
    "L'hôte a autorisé votre saisie. Cliquez sur la zone vidéo pour la sélectionner, puis interagissez comme en local.",
  "client.connected.inputBlocked":
    "L'hôte n'a pas activé le contrôle à distance. Vous pouvez regarder, mais vos clics et frappes restent sur cette page.",
  "client.connected.tips": "Astuces",
  "client.connected.tipsBody":
    "Si la vidéo paraît floue, essayez de redimensionner la fenêtre — l'écran de l'hôte est mis à l'échelle. Cliquez sur la vidéo pour la sélectionner avant de saisir, afin que les touches soient envoyées à l'hôte. L'audio est joué si l'hôte a coché « Partager l'audio » dans le sélecteur du navigateur.",
};

const de: Dict = {
  "nav.brand": "Fernzugriff",
  "nav.tagline": "Peer · Sicher · Sofort",
  "nav.host": "Host",
  "nav.join": "Beitreten",
  "nav.badge": "Bildschirmfreigabe nur mit Bestätigung",

  "home.title": "Fernzugriff",
  "home.titleSub": "mit einem Klick, ohne Hintertür.",
  "home.intro":
    "Teilen Sie Ihren Bildschirm mit einer vertrauenswürdigen Person — jede Verbindung erfordert Ihre ausdrückliche Bestätigung. Keine automatische Annahme, keine Hintergrundfreigabe — nichts geschieht ohne Ihren Klick.",
  "home.host.title": "Meinen Bildschirm teilen (Host)",
  "home.host.desc":
    "Erzeugen Sie einen Einmalcode. Ein Client muss ihn eingeben, und Sie müssen die Anfrage bestätigen, bevor irgendetwas startet.",
  "home.client.title": "Geteilten Bildschirm sehen (Client)",
  "home.client.desc":
    "Geben Sie den Code des Hosts ein. Sie sehen 'warte auf Bestätigung', bis er akzeptiert — dann erscheint der Bildschirm.",
  "home.privacy.label": "Datenschutz:",
  "home.privacy.body":
    "Ihr Bildschirm wird direkt mit dem Betrachter geteilt. Der Server vermittelt nur den Verbindungsaufbau — der Bildschirminhalt wird niemals gespeichert oder über ihn übertragen.",

  "host.idle.title": "Bildschirm freigeben",
  "host.idle.intro":
    "Erstellen Sie eine Sitzung — wir geben Ihnen einen kurzen Code zum Teilen. Jede Verbindungsanfrage benötigt Ihre ausdrückliche Bestätigung.",
  "host.idle.nameLabel": "Ihr Anzeigename (optional)",
  "host.idle.create": "Sitzung erstellen",
  "host.idle.preparing": "Sitzung wird vorbereitet…",
  "host.idle.sessionEnded": "Sitzung beendet.",

  "host.creating.label": "Wird erstellt…",
  "host.creating.title": "Ihre Sitzung wird eingerichtet",
  "host.creating.subtitle": "Verbindung zum Server…",

  "host.waiting.statusPill": "Sitzung erstellt — wartet auf Anfrage",
  "host.waiting.title": "Warte auf Anfrage",
  "host.waiting.intro":
    "Teilen Sie diesen Code mit der Person, die Ihren Bildschirm sehen möchte.",
  "host.waiting.codeLabel": "Sitzungscode",
  "host.waiting.copyCode": "Code kopieren",
  "host.waiting.copyLink": "Link kopieren",
  "host.waiting.linkShort": "Link",
  "host.waiting.shieldHead": "Es wird nichts geteilt, bis Sie bestätigen.",
  "host.waiting.shieldBody":
    "Sobald der Code eingegeben wurde, sehen Sie hier die Anfrage und können sie bestätigen oder ablehnen.",

  "host.request.statusPill": "Eingehende Anfrage von {name}",
  "host.request.title": "Eingehende Verbindungsanfrage",
  "host.request.intro":
    "{name} möchte Ihren Bildschirm in Sitzung {code} sehen. Sie können bestätigen oder ablehnen.",
  "host.request.requestingMeta": "fordert Zugriff an · Sitzung {code}",
  "host.request.helper":
    "Mit der Bestätigung wählen Sie einen Bildschirm oder ein Fenster zum Teilen — Sie können auch dort noch abbrechen.",
  "host.request.approve": "Bestätigen & teilen",
  "host.request.reject": "Ablehnen",

  "host.connecting.statusPill": "Verbinden…",
  "host.connecting.title": "Verbinden…",
  "host.connecting.intro":
    "Bitte wählen Sie den Bildschirm oder das Fenster, das Sie teilen möchten.",

  "host.connected.statusPill": "Verbunden mit {name}",
  "host.connected.endSession": "Sitzung beenden",
  "host.connected.micOn": "Mikro an",
  "host.connected.micOff": "Mikro aus",
  "host.connected.micToggleOn": "Mikrofon einschalten",
  "host.connected.micToggleOff": "Mikrofon ausschalten",
  "host.connected.hideInfo": "Info ausblenden",
  "host.connected.showInfo": "Info",
  "host.connected.hideInfoTitle": "Info-Bereich ausblenden",
  "host.connected.showInfoTitle": "Info-Bereich anzeigen",
  "host.connected.livePreview": "Live-Vorschau",
  "host.connected.previewBlurb":
    "Dies ist die Vorschau dessen, was {name} sieht. Sie können jederzeit oben auf 'Sitzung beenden' klicken oder die native Browser-Funktion 'Freigabe beenden' verwenden.",
  "host.connected.session": "Sitzung",
  "host.connected.remoteInput": "Ferneingabe",
  "host.connected.remoteInputBlurb":
    "Wird beim Bestätigen automatisch aktiviert. Schalten Sie sie als Notbremse AUS (der Cursor reagiert sofort nicht mehr).",
  "host.connected.localAgent": "Lokaler Maus-Agent",
  "host.connected.agent.up": "Bereit",
  "host.connected.agent.warming": "Vorwärmen",
  "host.connected.agent.connecting": "Verbinden",
  "host.connected.agent.down": "Offline",
  "host.connected.agent.off": "Inaktiv",
  "host.connected.agent.upBlurb": "Maus-Ereignisse werden eingespielt",
  "host.connected.agent.upBlurbVia": " über {backend}.",
  "host.connected.agent.warmingBlurb":
    "Agent verbunden, Backend wärmt auf. PowerShell lädt den Win32-Wrapper — meist unter einer Sekunde.",
  "host.connected.agent.warmingBlurbVb6":
    "Agent verbunden, Backend wärmt auf. Starten Sie MouseControl.exe — sollte in einer Sekunde verbunden sein.",
  "host.connected.agent.connectingBlurb": "Verbinde mit lokalem Agenten…",
  "host.connected.agent.downBlurb":
    "Lokaler Agent nicht erreichbar. `npm start` im Ordner agent/ ausführen.",
  "host.connected.agent.offBlurb":
    "Einschalten, um die Ferneingabe zuzulassen.",
  "host.connected.recentEvents": "Letzte Ereignisse",
  "host.connected.noEvents": "Keine Eingabe empfangen.",

  "host.micUnavailable": "Mikrofon nicht verfügbar",
  "host.micUnavailable.body":
    "Auf das Mikrofon konnte nicht zugegriffen werden. Bitte Browser-Berechtigungen prüfen.",
  "host.dismiss": "Schließen",
  "host.warn.cursorOffline":
    "Der Remote-Cursor bewegt sich nicht — der lokale Agent ist offline.",
  "host.warn.starting":
    "Lokaler Agent startet… der Cursor reagiert in Kürze.",
  "host.warn.connecting": "Verbinde mit lokalem Agenten…",
  "host.warn.notStarted": "Lokaler Agent nicht gestartet.",
  "host.warn.fixIntro":
    "Der lokale Helfer ist auf diesem PC nicht erreichbar. Zwei Dinge prüfen:",
  "host.warn.fix1":
    "Diese Seite muss auf demselben Computer geöffnet sein, der gesteuert werden soll. Der Helfer arbeitet nur lokal — er ist von einem anderen Rechner aus nicht erreichbar.",
  "host.warn.fix2.before":
    "Helfer installieren oder neu starten: öffnen Sie den Ordner ",
  "host.warn.fix2.after":
    " auf diesem PC und doppelklicken Sie Setup.cmd. Falls bereits installiert, führen Sie Diagnose.cmd für eine Übersicht aus.",

  "host.dc.serverUnreachable": "Server konnte nicht erreicht werden.",
  "host.dc.connectionClosed": "Die Verbindung wurde geschlossen.",
  "host.dc.shareCancelled": "Die Bildschirmfreigabe wurde abgebrochen.",
  "host.dc.youStopped": "Sie haben die Bildschirmfreigabe beendet.",
  "host.dc.youEnded": "Sie haben die Sitzung beendet.",
  "host.dc.connClosed": "Verbindung geschlossen: {reason}",
  "host.event.clientLeft": "Client verlassen ({reason})",
  "host.event.error": "Fehler: {message}",

  "client.idle.title": "Sitzung beitreten",
  "client.idle.intro":
    "Fragen Sie den Host nach dem Sitzungscode. Der Host muss Ihre Anfrage bestätigen, bevor etwas geteilt wird.",
  "client.idle.nameLabel": "Ihr Anzeigename",
  "client.idle.namePlaceholder": "Wie soll der Host Sie erkennen?",
  "client.idle.codeLabel": "Sitzungscode",
  "client.idle.send": "Anfrage senden",
  "client.idle.connecting": "Verbinden…",

  "client.sessionEnded": "Sitzung beendet.",
  "client.requestRejected": "Anfrage abgelehnt.",
  "client.dc.serverUnreachable": "Server konnte nicht erreicht werden.",
  "client.dc.connectionClosed": "Die Verbindung wurde geschlossen.",
  "client.dc.cancelled": "Sie haben die Anfrage abgebrochen.",
  "client.dc.disconnected": "Sie haben die Verbindung getrennt.",
  "client.dc.hostLeft": "Host verlassen: {reason}",
  "client.dc.invalidCode":
    "Dieser Code ist nicht gültig. Bitten Sie den Host um einen neuen.",
  "client.dc.sessionFull": "Der Host ist bereits mit einem anderen Betrachter verbunden.",
  "client.dc.sessionEndedEarly":
    "Der Host hat die Sitzung beendet, bevor Sie beigetreten sind.",
  "client.dc.hostRejected": "Der Host hat Ihre Anfrage abgelehnt.",
  "client.dc.connClosed": "Verbindung geschlossen: {reason}",

  "client.requesting.statusPill": "Anfrage wird gesendet…",
  "client.requesting.title": "Verbindungsanfrage",
  "client.requesting.intro": "Verbinde mit Code {code}.",
  "client.waiting.statusPill": "Warte auf Bestätigung",
  "client.waiting.title": "Warte auf den Host",
  "client.waiting.intro":
    "Ihre Anfrage hat den Host erreicht. Sie sehen seinen Bildschirm, sobald er bestätigt. Sie können jederzeit abbrechen.",
  "client.waiting.shield":
    "Bitten Sie den Host, in seiner Anfrageliste der Sitzung {code} nach {name} zu suchen.",
  "client.waiting.cancel": "Anfrage abbrechen",

  "client.connecting.statusPill": "Bestätigt — verbinde…",
  "client.connecting.title": "Verbinde mit {code}",
  "client.connecting.intro":
    "Verbindung wird aufgebaut. Das dauert meist ein bis zwei Sekunden.",
  "client.connecting.cancel": "Abbrechen",

  "client.connected.statusPill": "Verbunden mit {code}",
  "client.connected.controlOn": "Fernsteuerung an",
  "client.connected.controlShort": "Steuerung",
  "client.connected.controlTitle":
    "Der Host hat Ihnen die Ferneingabe gewährt.",
  "client.connected.unmute": "Ton an",
  "client.connected.mute": "Stumm",
  "client.connected.unmuteTitle": "Geteilten Ton einschalten",
  "client.connected.muteTitle": "Geteilten Ton stummschalten",
  "client.connected.fullscreen": "Vollbild",
  "client.connected.exitFullscreen": "Vollbild verlassen",
  "client.connected.exitFullscreenTitle": "Vollbild verlassen (Esc)",
  "client.connected.disconnect": "Trennen",
  "client.connected.disconnectTitle": "Verbindung zur Sitzung trennen",
  "client.connected.streaming": "Übertragung",
  "client.connected.controlBlurb":
    "Fernsteuerung ist aktiv — Ihre Klicks und Tasten werden an den Host weitergeleitet.",
  "client.connected.viewBlurb":
    "Nur Ansicht. Der Host steuert, ob Ihre Eingabe weitergeleitet wird.",
  "client.connected.session": "Sitzung",
  "client.connected.inputStatus": "Eingabestatus",
  "client.connected.inputAllowed":
    "Der Host hat Ihre Eingabe erlaubt. Klicken Sie in den Videobereich, um ihn zu fokussieren, und arbeiten Sie wie lokal.",
  "client.connected.inputBlocked":
    "Der Host hat die Fernsteuerung nicht aktiviert. Sie können zusehen, aber Klicks und Tasten bleiben auf dieser Seite.",
  "client.connected.tips": "Tipps",
  "client.connected.tipsBody":
    "Wenn das Video unscharf wirkt, ändern Sie die Fenstergröße — der Bildschirm des Hosts wird skaliert. Klicken Sie in das Video, bevor Sie tippen, damit die Tasten an den Host gehen. Audio wird wiedergegeben, falls der Host im Browser-Auswahlfenster 'Audio teilen' aktiviert hat.",
};

const DICTS: Record<Locale, Dict> = { en, fr, de };

// ─── Runtime API ────────────────────────────────────────────────────────

let currentLocale: Locale = DEFAULT_LOCALE;
const subscribers = new Set<(l: Locale) => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(next: Locale) {
  if (!SUPPORTED.includes(next)) return;
  if (next === currentLocale) return;
  currentLocale = next;
  try {
    window.localStorage.setItem(LS_KEY, next);
  } catch {
    /* ignore */
  }
  document.documentElement.setAttribute("lang", next);
  subscribers.forEach((cb) => cb(next));
}

/** Translate a key with `{placeholder}` interpolation. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[currentLocale] || DICTS[DEFAULT_LOCALE];
  let out = dict[key] ?? DICTS[DEFAULT_LOCALE][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return out;
}

/** React hook — re-renders when the locale changes. */
export function useLocale(): [Locale, (l: Locale) => void] {
  const [loc, setLoc] = useState<Locale>(currentLocale);
  useEffect(() => {
    const cb = (l: Locale) => setLoc(l);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  return [loc, setLocale];
}

// ─── Boot ───────────────────────────────────────────────────────────────

export function initI18n() {
  currentLocale = detectInitialLocale();
  document.documentElement.setAttribute("lang", currentLocale);

  // Live language switches from the embedding page (e.g. VE Admin).
  if (typeof window !== "undefined") {
    window.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data;
      let payload: unknown = data;
      if (typeof data === "string") {
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (
        payload &&
        typeof payload === "object" &&
        (payload as { type?: string }).type === "set-locale"
      ) {
        const raw = (payload as { locale?: string }).locale;
        const next = normalize(raw);
        if (next) setLocale(next);
      }
    });

    // React to the iframe URL changing (host might rewrite hash with new lang).
    window.addEventListener("hashchange", () => {
      const hash = window.location.hash || "";
      const queryStr = hash.includes("?")
        ? hash.slice(hash.indexOf("?") + 1)
        : "";
      const fromUrl = normalize(
        new URLSearchParams(queryStr).get("lang") ||
          new URLSearchParams(queryStr).get("locale"),
      );
      if (fromUrl) setLocale(fromUrl);
    });
  }
}
