import type { Locale } from './site';

export type CompanyPageId = 'about' | 'founders' | 'contact' | 'privacy' | 'terms' | 'imprint' | 'security';

type CompanyCopy = {
  company: string;
  legal: string;
  cofounder: string;
  profile: string;
  englishNotice: string;
  titles: Record<CompanyPageId, string>;
  summaries: Record<CompanyPageId, string>;
};

export const COMPANY_COPY: Record<Locale, CompanyCopy> = {
  en: {
    company: 'Company', legal: 'Legal', cofounder: 'Co-founder', profile: 'View LinkedIn profile', englishNotice: '',
    titles: { about: 'About Juror', founders: 'Meet the founders', contact: 'Contact Juror', privacy: 'Privacy policy', terms: 'Terms of service', imprint: 'Legal notice / Impressum', security: 'Security at Juror' },
    summaries: {
      about: 'Independent AI reviews, clear findings, and visible costs. Built by Jay Derinbogaz and Tugberk Ayar.',
      founders: 'Jay Derinbogaz and Tugberk Ayar are the co-founders of Juror, a multi-model code review product.',
      contact: 'Get in touch about Juror, your account, a partnership, or a privacy request.',
      privacy: 'How Juror handles personal data on our website, in Juror Cloud, and through connected review tools.',
      terms: 'Terms for the Juror website, hosted code reviews, browser QA, and connected clients.',
      imprint: 'Company information for Derinbogaz Ventures UG (haftungsbeschränkt), the operator of Juror.',
      security: 'How review execution, credentials, evidence, and vulnerability reporting are handled.',
    },
  },
  de: {
    company: 'Unternehmen', legal: 'Rechtliches', cofounder: 'Mitgründer', profile: 'LinkedIn-Profil ansehen', englishNotice: 'Der vollständige Inhalt dieser Seite ist derzeit auf Englisch verfügbar.',
    titles: { about: 'Über Juror', founders: 'Unsere Gründer', contact: 'Kontakt', privacy: 'Datenschutzerklärung', terms: 'Nutzungsbedingungen', imprint: 'Impressum', security: 'Sicherheit bei Juror' },
    summaries: {
      about: 'Unabhängige KI-Code-Reviews, klare Ergebnisse und transparente Kosten. Entwickelt von Jay Derinbogaz und Tugberk Ayar.',
      founders: 'Jay Derinbogaz und Tugberk Ayar sind die Mitgründer von Juror, einem Produkt für Code-Reviews mit mehreren KI-Modellen.',
      contact: 'Kontakt zu Juror bei Fragen zum Produkt, zu Ihrem Konto, zu Partnerschaften oder zum Datenschutz.',
      privacy: 'Informationen zur Verarbeitung personenbezogener Daten auf unserer Website, in Juror Cloud und über verbundene Tools.',
      terms: 'Bedingungen für die Juror-Website, gehostete Code-Reviews, Browser-QA und verbundene Clients.',
      imprint: 'Anbieterangaben der Derinbogaz Ventures UG (haftungsbeschränkt), Betreiberin von Juror.',
      security: 'Informationen zu Review-Ausführung, Zugangsdaten, QA-Nachweisen und dem Melden von Sicherheitslücken.',
    },
  },
  fr: {
    company: 'Entreprise', legal: 'Informations légales', cofounder: 'Cofondateur', profile: 'Voir le profil LinkedIn', englishNotice: 'Le contenu complet de cette page est actuellement disponible en anglais.',
    titles: { about: 'À propos de Juror', founders: 'Nos fondateurs', contact: 'Contacter Juror', privacy: 'Politique de confidentialité', terms: 'Conditions d’utilisation', imprint: 'Mentions légales', security: 'Sécurité chez Juror' },
    summaries: {
      about: 'Des revues de code indépendantes, des résultats clairs et des coûts visibles. Créé par Jay Derinbogaz et Tugberk Ayar.',
      founders: 'Jay Derinbogaz et Tugberk Ayar sont les cofondateurs de Juror, un produit de revue de code avec plusieurs modèles d’IA.',
      contact: 'Contactez-nous au sujet de Juror, de votre compte, d’un partenariat ou de vos données personnelles.',
      privacy: 'Le traitement des données personnelles sur notre site, dans Juror Cloud et via les outils connectés.',
      terms: 'Conditions applicables au site Juror, aux revues hébergées, aux tests de navigateur et aux clients connectés.',
      imprint: 'Informations sur Derinbogaz Ventures UG (haftungsbeschränkt), la société exploitant Juror.',
      security: 'Exécution des revues, identifiants, preuves de test et signalement des vulnérabilités.',
    },
  },
  es: {
    company: 'Empresa', legal: 'Información legal', cofounder: 'Cofundador', profile: 'Ver perfil de LinkedIn', englishNotice: 'El contenido completo de esta página está disponible actualmente en inglés.',
    titles: { about: 'Acerca de Juror', founders: 'Nuestros fundadores', contact: 'Contactar con Juror', privacy: 'Política de privacidad', terms: 'Condiciones del servicio', imprint: 'Aviso legal', security: 'Seguridad en Juror' },
    summaries: {
      about: 'Revisiones de código independientes, resultados claros y costes visibles. Creado por Jay Derinbogaz y Tugberk Ayar.',
      founders: 'Jay Derinbogaz y Tugberk Ayar son los cofundadores de Juror, un producto de revisión de código con varios modelos de IA.',
      contact: 'Contacta con nosotros sobre Juror, tu cuenta, colaboraciones o solicitudes de privacidad.',
      privacy: 'Cómo se tratan los datos personales en nuestra web, en Juror Cloud y mediante herramientas conectadas.',
      terms: 'Condiciones de la web de Juror, las revisiones alojadas, las pruebas de navegador y los clientes conectados.',
      imprint: 'Información de Derinbogaz Ventures UG (haftungsbeschränkt), la empresa que opera Juror.',
      security: 'Ejecución de revisiones, credenciales, pruebas y comunicación de vulnerabilidades.',
    },
  },
  ja: {
    company: '運営会社', legal: '法的情報', cofounder: '共同創業者', profile: 'LinkedInプロフィールを見る', englishNotice: 'このページの本文は現在、英語で提供されています。',
    titles: { about: 'Jurorについて', founders: '創業者の紹介', contact: 'お問い合わせ', privacy: 'プライバシーポリシー', terms: '利用規約', imprint: '運営会社情報', security: 'Jurorのセキュリティ' },
    summaries: {
      about: '独立したAIコードレビュー、明確な検出結果、見えるコスト。Jay DerinbogazとTugberk Ayarが開発。',
      founders: 'Jay DerinbogazとTugberk Ayarは、複数のAIモデルでコードをレビューするJurorの共同創業者です。',
      contact: 'Juror、アカウント、提携、個人情報に関するお問い合わせ先。',
      privacy: 'ウェブサイト、Juror Cloud、接続されたツールにおける個人情報の取り扱いについて。',
      terms: 'Jurorのウェブサイト、ホスト型コードレビュー、ブラウザQA、接続クライアントの利用条件。',
      imprint: 'Jurorを運営するDerinbogaz Ventures UG (haftungsbeschränkt)の会社情報。',
      security: 'レビューの実行、認証情報、テスト証跡、脆弱性の報告について。',
    },
  },
  'pt-BR': {
    company: 'Empresa', legal: 'Informações legais', cofounder: 'Cofundador', profile: 'Ver perfil no LinkedIn', englishNotice: 'O conteúdo completo desta página está disponível atualmente em inglês.',
    titles: { about: 'Sobre o Juror', founders: 'Nossos fundadores', contact: 'Fale com o Juror', privacy: 'Política de privacidade', terms: 'Termos de serviço', imprint: 'Aviso legal', security: 'Segurança no Juror' },
    summaries: {
      about: 'Revisões de código independentes, resultados claros e custos visíveis. Criado por Jay Derinbogaz e Tugberk Ayar.',
      founders: 'Jay Derinbogaz e Tugberk Ayar são os cofundadores do Juror, um produto de revisão de código com vários modelos de IA.',
      contact: 'Entre em contato sobre o Juror, sua conta, parcerias ou solicitações de privacidade.',
      privacy: 'Como os dados pessoais são tratados no site, no Juror Cloud e nas ferramentas conectadas.',
      terms: 'Condições do site Juror, das revisões hospedadas, dos testes de navegador e dos clientes conectados.',
      imprint: 'Informações da Derinbogaz Ventures UG (haftungsbeschränkt), empresa que opera o Juror.',
      security: 'Execução de revisões, credenciais, evidências e comunicação de vulnerabilidades.',
    },
  },
};

export function isCompanyPage(id: string): id is CompanyPageId {
  return Object.hasOwn(COMPANY_COPY.en.titles, id);
}
