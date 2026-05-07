export const articles = {
  protection: {
    title: "How Your Data is Protected",
    content: `
      <p>OnlyTwo uses strict <strong>End-to-End Encryption</strong>. Before any message or file leaves your device, it is locked using a highly secure key.</p>
      <p>The only key that can unlock it exists exclusively on your peer's device. We do not have the keys, making it physically impossible for our servers, developers, or network providers to read your messages.</p>
      <p>Furthermore, the lock changes after every single message. Even if someone were to compromise your device in the future, they cannot decipher messages you sent in the past.</p>
    `,
  },
  retention: {
    title: "Data Retention & Storage",
    content: `
      <p>Traditional chat apps store your message history in cloud databases. <strong>We do not.</strong></p>
      <p>Our server operates purely as a relay — a digital pipe. It receives an encrypted message from you and immediately pushes it to your peer. We do not use databases, and we do not save your files.</p>
      <p>The moment you close this app or end the session, all connection data is instantly erased from our server's memory. Your chat history lives solely on your screen and vanishes when you leave.</p>
    `,
  },
  verification: {
    title: "Verifying Your Connection",
    content: `
      <p>How do you know you are actually talking to your peer and not an imposter intercepting the connection?</p>
      <p>Once connected, a <strong>Security Code</strong> appears at the top of your chat. This code is mathematically generated based on your secure connection. If your code and your peer's code match exactly, your connection is guaranteed to be secure and strictly between the two of you.</p>
      <p>We recommend verifying this code with your peer over a phone call or in person before sharing sensitive information.</p>
    `,
  },
  privacy: {
    title: "Privacy & Anonymity",
    content: `
      <p>We believe privacy is a fundamental right. Because of this, OnlyTwo is designed to require absolutely <strong>no personal information</strong>.</p>
      <p>We do not ask for your phone number, email address, or name. There are no accounts to register, and no profiles to create. You are entirely anonymous.</p>
      <p>To further protect your identity, we recommend using this service while connected to a trusted VPN, which will hide your personal IP address from your network provider.</p>
    `,
  },
} as const;

export type ArticleKey = keyof typeof articles;
