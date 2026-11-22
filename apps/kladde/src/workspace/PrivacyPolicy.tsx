type Pair = readonly [german: string, english: string];

interface Section {
  heading: Pair;
  paragraphs: readonly Pair[];
}

const SECTIONS: readonly Section[] = [
  {
    heading: ["Verantwortlicher", "Controller"],
    paragraphs: [
      [
        "Lucas Deutschland, datenschutz@deutschland.sh",
        "Lucas Deutschland, datenschutz@deutschland.sh",
      ],
    ],
  },
  {
    heading: ["Grundsatz", "Principle"],
    paragraphs: [
      [
        "Kladde funktioniert ohne Konto. Notizen, Dateien und Einstellungen liegen verschlüsselt auf deinem Gerät, der Schlüssel im Schlüsselbund des Geräts. Wir erhalten keine Inhalte. Es gibt keine Werbung, keine Nutzungsanalyse und kein Tracking.",
        "Kladde works without an account. Notes, files and settings are stored encrypted on your device, the key in the device keychain. We receive no content. There is no advertising, no usage analytics and no tracking.",
      ],
    ],
  },
  {
    heading: ["Synchronisieren (freiwillig)", "Sync (optional)"],
    paragraphs: [
      [
        "Nur wenn du ein Konto auf einem Relay-Server einrichtest, werden Daten übertragen. Inhalte werden vorher auf dem Gerät Ende-zu-Ende verschlüsselt, der Server kann sie nicht lesen. Er verarbeitet deinen Benutzernamen, die verschlüsselten Daten, technische Angaben wie Größe, Zeitpunkt, Geräte- und Notizbuchkennungen sowie deine IP-Adresse, um den Abgleich zu ermöglichen. Verantwortlich dafür ist der Betreiber des Servers, dessen Adresse du einträgst.",
        "Data is only transferred if you set up an account on a relay server. Content is end-to-end encrypted on your device first, the server cannot read it. It processes your user name, the encrypted data, technical details such as size, time, device and notebook identifiers, and your IP address to make syncing work. The operator of the server whose address you enter is responsible for it.",
      ],
      [
        "Konto und Serverdaten löschst du jederzeit unter Einstellungen → Synchronisieren.",
        "You can delete your account and server data at any time under Settings → Sync.",
      ],
    ],
  },
  {
    heading: [
      "KI (freiwillig, standardmäßig aus)",
      "AI (optional, off by default)",
    ],
    paragraphs: [
      [
        "Erst nach deiner ausdrücklichen Zustimmung sendet Kladde die Inhalte, die du der KI gibst, im Klartext mit deinem eigenen Schlüssel an OpenRouter (OpenRouter, Inc., USA) und an den Anbieter des gewählten Modells. Die Websuche sendet Suchbegriffe über OpenRouter an Exa. Dafür gelten die Datenschutzbestimmungen dieser Anbieter. Rechtsgrundlage ist deine Einwilligung (Art. 6 Abs. 1 lit. a DSGVO). Du kannst die KI jederzeit in den Einstellungen ausschalten.",
        "Only after your explicit consent does Kladde send the content you give the AI in plaintext, using your own key, to OpenRouter (OpenRouter, Inc., USA) and to the provider of the chosen model. Web search sends queries through OpenRouter to Exa. Their privacy policies apply. The legal basis is your consent (Art. 6(1)(a) GDPR). You can turn AI off in the settings at any time.",
      ],
    ],
  },
  {
    heading: ["Web-Clips und Bilder", "Web clips and images"],
    paragraphs: [
      [
        "Wenn du eine Adresse clippst oder beim Import externe Bilder laden lässt, ruft dein Gerät die Seite direkt ab. Der jeweilige Webserver sieht dabei deine IP-Adresse.",
        "When you clip an address or let an import load external images, your device fetches the page directly. That web server sees your IP address.",
      ],
    ],
  },
  {
    heading: ["Audionotizen", "Audio notes"],
    paragraphs: [
      [
        "Aufnahme und Umwandlung in Text finden auf dem Gerät statt. Sprachmodelle lädt das Betriebssystem bei Bedarf von Apple.",
        "Recording and transcription happen on the device. The operating system downloads speech models from Apple when needed.",
      ],
    ],
  },
  {
    heading: ["Deine Rechte", "Your rights"],
    paragraphs: [
      [
        "Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerruf einer Einwilligung sowie auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde.",
        "You have the right to access, rectification, erasure, restriction of processing, data portability and withdrawal of consent, and to lodge a complaint with a data protection supervisory authority.",
      ],
    ],
  },
];

export function PrivacyPolicy({ lang }: { lang: string }) {
  const index = lang === "en" ? 1 : 0;

  return (
    <div className="privacypolicy">
      {SECTIONS.map((section) => (
        <section key={section.heading[0]}>
          <h3>{section.heading[index]}</h3>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph[0]}>{paragraph[index]}</p>
          ))}
        </section>
      ))}
    </div>
  );
}
