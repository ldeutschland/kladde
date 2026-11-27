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
        "Für die Synchronisierung werden Daten nur übertragen, wenn du ein Konto auf einem Relay-Server einrichtest. Inhalte werden vorher auf dem Gerät Ende-zu-Ende verschlüsselt, der Server kann sie nicht lesen. Er verarbeitet deinen Benutzernamen, die verschlüsselten Daten, technische Angaben wie Größe, Zeitpunkt, Geräte- und Notizbuchkennungen, Mitgliedschaften, öffentliche Schlüssel sowie deine IP-Adresse, um die Synchronisierung zu ermöglichen. Verantwortlich dafür ist der Betreiber des Servers, dessen Adresse du einträgst.",
        "For syncing, data is only transferred if you set up an account on a relay server. Content is end-to-end encrypted on your device first, the server cannot read it. It processes your user name, the encrypted data, technical details such as size, time, device and notebook identifiers, memberships, public keys, and your IP address to make syncing work. The operator of the server whose address you enter is responsible for it.",
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
        "Erst nach deiner ausdrücklichen Zustimmung sendet Kladde die Inhalte, die du der KI gibst oder die der Assistent für deine Anfrage liest, sowie deine KI-Anweisungen und Erinnerungen im Klartext mit deinem eigenen Schlüssel an OpenRouter (OpenRouter, Inc., USA) und an den Anbieter des gewählten Modells. Seiten, die du von der KI ausschließt, werden nicht gesendet. Standardmäßig nutzt Kladde nur Anbieter ohne Datenspeicherung. Die Websuche sendet Suchbegriffe über OpenRouter an Exa. Dafür gelten die Datenschutzbestimmungen dieser Anbieter. Rechtsgrundlage ist deine Einwilligung (Art. 6 Abs. 1 lit. a DSGVO). Du kannst die KI jederzeit in den Einstellungen ausschalten.",
        "Only after your explicit consent does Kladde send the content you give the AI or that the assistant reads for your request, along with your AI instructions and memories, in plaintext, using your own key, to OpenRouter (OpenRouter, Inc., USA) and to the provider of the chosen model. Pages you exclude from AI are never sent. By default Kladde only uses providers without data retention. Web search sends queries through OpenRouter to Exa. Their privacy policies apply. The legal basis is your consent (Art. 6(1)(a) GDPR). You can turn AI off in the settings at any time.",
      ],
      [
        "Auf iPhone und Mac kannst du stattdessen „Auf diesem Gerät (Gemma 4)“ wählen. Dann lädt Kladde einmalig ein Sprachmodell von Hugging Face (Hugging Face, Inc., USA) herunter. Hugging Face sieht dabei deine IP-Adresse, aber keine Inhalte, und Kladde prüft die Datei anhand einer festen Prüfsumme. Danach verarbeitet das Modell deine Anfragen ausschließlich auf deinem Gerät, und Kladde sendet dafür nichts an OpenRouter oder andere Anbieter.",
        "On iPhone and Mac you can choose “On this device (Gemma 4)” instead. Kladde then downloads a language model once from Hugging Face (Hugging Face, Inc., USA), which sees your IP address but no content, and checks the file against a fixed checksum. After that the model processes your requests only on your device, and Kladde sends nothing to OpenRouter or any other provider for them.",
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
        "Aufnahme und Umwandlung in Text finden auf dem Gerät statt. Sprachmodelle lädt das Betriebssystem bei Bedarf von Apple, Apple erfährt dabei die gewählte Sprache.",
        "Recording and transcription happen on the device. The operating system downloads speech models from Apple when needed, which tells Apple the chosen language.",
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
  {
    heading: ["Support", "Support"],
    paragraphs: [["kontakt@deutschland.sh", "kontakt@deutschland.sh"]],
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
