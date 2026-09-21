// Public company details: Apple trader disclosure and public commercial-register records.
// https://apps.apple.com/dk/app/fireburst/id6800782127
// https://www.unternehmen24.info/Firmeninformationen/Deutschland/Firma/4916141
// https://www.unternehmen24.info/Handelsregister/Deutschland/Handelsregisterauszug/Firma/4916141
// Founder names and profile URLs were supplied by the company on 2026-09-21.
export const COMPANY = {
  name: 'Derinbogaz Ventures UG (haftungsbeschränkt)',
  street: 'Kolonnenstraße 8',
  postalCode: '10827',
  city: 'Berlin',
  country: 'Germany',
  managingDirector: 'Ceyhun Afsin Derinbogaz',
  registerCourt: 'Amtsgericht Charlottenburg (Berlin)',
  registerNumber: 'HRB 232104 B',
  email: 'jay@stackcap.cc',
  phone: '+49 151 58041814',
  phoneHref: 'tel:+4915158041814',
} as const;

export const FOUNDERS = [
  { name: 'Jay Derinbogaz', initials: 'JD', linkedIn: 'https://www.linkedin.com/in/ceyhunderinbogaz/' },
  { name: 'Tugberk Ayar', initials: 'TA', linkedIn: 'https://www.linkedin.com/in/tugberkayar/' },
] as const;

export const POLICY_DATE = '2026-09-21';
export const COMPANY_ADDRESS = `${COMPANY.street}, ${COMPANY.postalCode} ${COMPANY.city}, ${COMPANY.country}`;

export type PolicySection = {
  id: string;
  title: string;
  paragraphs: string[];
  items?: string[];
  links?: { label: string; href: string }[];
};

export type Policy = { title: string; summary: string; sections: PolicySection[] };
export type PolicyId = 'privacy' | 'terms' | 'imprint' | 'security';

const contactLink = { label: COMPANY.email, href: `mailto:${COMPANY.email}` };
const repository = 'https://github.com/Juror-AI/juror';

// Shared by the static marketing site and the hosted app to keep notices consistent.
// Processing details are based on cloud/worker/{auth,index,corpus,workspace-delete}.ts,
// cloud/README.md, SECURITY.md and docs/threat-model.md. This is policy copy, not a
// claim of external legal review or certification.
export const POLICIES: Record<PolicyId, Policy> = {
  privacy: {
    title: 'Privacy policy',
    summary: 'How Juror handles personal data on juror.dev, in Juror Cloud, and through connected review tools.',
    sections: [
      {
        id: 'controller', title: 'Who is responsible',
        paragraphs: [
          `Juror is operated by ${COMPANY.name}, ${COMPANY_ADDRESS}. We are responsible for personal data used to run our website, manage accounts, communicate with you, secure the service, and administer billing. Contact us at ${COMPANY.email} for privacy questions or requests.`,
          'When a customer submits repository or QA data containing personal information, the customer determines the purpose of that processing. Our role and instructions for that data are governed by the applicable service and data-processing agreement. If you participate in someone else’s workspace, its administrator controls access and configured processing.',
        ], links: [contactLink],
      },
      {
        id: 'data', title: 'Data we process and why',
        paragraphs: ['The data involved depends on the features you use. It can come from you, your workspace administrator, your sign-in provider, GitHub, or a connected client.'],
        items: [
          'Website requests: IP address, browser and device information, requested URL, time, and security or error information needed to deliver pages, investigate failures, and prevent abuse.',
          'Accounts and workspaces: name, email address, profile image, provider identifiers, session and authorization records, memberships, roles, and settings needed for sign-in and access control.',
          'Repository reviews: selected repository and pull-request metadata, commit identifiers, source context, diffs, comments, findings, and usage receipts needed to perform and present a review.',
          'Browser QA: configured target URLs, test instructions, credentials, and captured screenshots, traces, or video where enabled. Use test accounts and synthetic data; evidence can contain information displayed by the tested application.',
          'Payments and support: billing identifiers, usage, payment status, invoice information, and information you choose to include in correspondence. Stripe handles payment details; do not send card details or credentials in support requests.',
        ],
      },
      {
        id: 'legal-bases', title: 'Legal bases',
        paragraphs: [
          'We rely on contract performance for requested services (GDPR Article 6(1)(b)), legal obligations for required business records (Article 6(1)(c)), and legitimate interests in secure operations, account administration, and responding to business enquiries (Article 6(1)(f)). Where processing requires consent, we rely on Article 6(1)(a); you may withdraw it without affecting earlier lawful processing.',
          'Account identity and authorized repository access are necessary for the corresponding hosted features. Without them, those features cannot operate. Optional training collection is not required to use reviews.',
        ],
      },
      {
        id: 'providers', title: 'Service providers and sharing',
        paragraphs: [
          'Cloudflare provides website delivery, hosted compute, databases, and object storage. GitHub provides sign-in, repository access, events, and review publishing. Google processes sign-in when you choose that option. Stripe processes hosted billing.',
          'Review context is sent to the AI providers selected by the run configuration. Supported integrations include OpenAI, Anthropic, xAI, DeepSeek, Fireworks AI, OpenRouter, Scaleway, and Moonshot AI; not every provider is used for every run. Routing services may forward requests to the model provider. Their handling and retention are subject to the applicable provider terms.',
          'Workspace members can see information permitted by their role. If review publishing is enabled, findings and summaries are sent back to GitHub and are visible to people who can access that repository, including the public for public repositories. We may also disclose information where legally required or necessary to establish or defend legal claims. We do not sell personal information.',
        ], links: [
          { label: 'Cloudflare privacy policy', href: 'https://www.cloudflare.com/privacypolicy/' },
          { label: 'GitHub privacy statement', href: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement' },
          { label: 'Google privacy policy', href: 'https://policies.google.com/privacy' },
          { label: 'Stripe privacy policy', href: 'https://stripe.com/privacy' },
        ],
      },
      {
        id: 'retention', title: 'Storage and deletion',
        paragraphs: [
          'Source checkouts are temporary run inputs in isolated execution environments and are cleaned up after execution. Full patches and model scratch text are not stored as dashboard reports. Findings and reports can still contain relevant code excerpts; redaction cannot guarantee removal of every piece of personal information.',
          'Stored report files expire after 365 days and QA evidence after 90 days, with removal performed by scheduled cleanup. Resolved or ignored findings older than 365 days are also removed. Open findings, run metadata, account records, and billing records have different purposes and are not all deleted when a report file expires.',
          'Account and workspace records are kept while needed to operate the account. Administrators can request workspace deletion in Settings; this is an asynchronous process that stops runs and removes workspace data and stored objects. Contact us for account-level requests. Billing records, security records, correspondence, and records needed for legal claims may be retained as required by law or for as long as their documented purpose requires. Copies already published to GitHub or exported to another service are controlled separately.',
        ],
      },
      {
        id: 'training', title: 'Optional training collection',
        paragraphs: [
          'Training collection is off by default. A workspace administrator must explicitly enable workspace-private improvement or shared Juror training, acknowledge the collection terms, and choose repositories. The administrator is responsible for having authority and a lawful basis to include contributors’ data; this setting does not replace an individual’s data protection rights.',
          'Enabled collection includes selected review and conversation content. It is filtered, redacted, pseudonymized, and encrypted per workspace before storage. Raw file paths and PR descriptions require separate opt-ins. Source files, diffs, direct identity fields, credentials, and model scratch text are excluded from this corpus. Free text may still contain personal information.',
          'Collection begins at opt-in. Administrators can disable future collection, export the corpus, or request its deletion in Settings. Retention follows the workspace’s selected period, with scheduled deletion after expiry. Disabling collection alone does not delete previously collected data; use the deletion control for that.',
        ],
      },
      {
        id: 'connected-clients', title: 'Connected clients and local use',
        paragraphs: [
          'ChatGPT, Codex, and other MCP clients connect through OAuth and your existing workspace permissions. They can receive permitted metadata and specifically requested retained finding content. The integration does not return raw diffs, source checkouts, full reports, screenshots, provider credentials, or prompt text. Starting a hosted review requires a separate confirmation. A client’s handling of data it receives is governed by that client’s policy; revocation stops future access but does not recall earlier exports.',
          'The open-source CLI and GitHub Action run in infrastructure you choose. Their model requests go to your configured providers. Installing the open-source software alone does not create a Juror Cloud account or send its reviews to our dashboard.',
        ],
      },
      {
        id: 'cookies', title: 'Cookies and browser storage',
        paragraphs: [
          'Juror Cloud uses essential authentication cookies to maintain sessions and protect sign-in. Blocking these cookies can prevent sign-in from working. Our marketing application does not include advertising pixels or a cross-site advertising tracker. Infrastructure providers may process request and security data to deliver and protect the website. Following a LinkedIn, GitHub, or other external link takes you to a service with its own privacy and cookie practices.',
        ],
      },
      {
        id: 'international', title: 'International processing',
        paragraphs: [
          'Our service providers and selected AI providers may process information outside your country, including outside the EEA. Applicable transfer arrangements depend on the provider and service agreement. Where GDPR applies, a transfer requires an applicable adequacy decision or appropriate safeguards, such as standard contractual clauses. Contact us for information about the applicable arrangements or a copy of the relevant safeguards, and before submitting data with location restrictions. Juror does not promise EEA-only processing.',
        ],
      },
      {
        id: 'rights', title: 'Your rights',
        paragraphs: [
          'Where applicable, you may request access, correction, deletion, restriction, or portability, and object to processing based on legitimate interests. You may withdraw consent and complain to a supervisory authority, including the Berlin Commissioner for Data Protection and Freedom of Information. We may need information to verify your identity. For customer-controlled repository data, contact the workspace administrator; we can help route your request.',
          'Juror produces code-review suggestions. We do not use them to make solely automated decisions about you with legal or similarly significant effects. People remain responsible for review and merge decisions.',
        ], links: [contactLink, { label: 'Berlin data protection authority', href: 'https://www.datenschutz-berlin.de/' }],
      },
      {
        id: 'updates', title: 'Policy updates',
        paragraphs: ['We update this policy when our service or processing changes. The date on this page identifies the current version. Material changes that require notice or consent will be handled through the service or an appropriate direct communication.'],
      },
    ],
  },
  terms: {
    title: 'Terms of service',
    summary: 'Terms for the Juror website, hosted code reviews, browser QA, and connected clients.',
    sections: [
      {
        id: 'agreement', title: 'Who these terms cover',
        paragraphs: [
          `These terms govern use of juror.dev and the hosted Juror Cloud service provided by ${COMPANY.name}, ${COMPANY_ADDRESS}. “You” means the person or organization using the service. If you act for an organization, you must be authorized to accept terms and configure processing on its behalf. Contact ${COMPANY.email} with contract questions.`,
          'A separately agreed order or service agreement takes precedence where it conflicts with these terms. The open-source CLI and GitHub Action are separately licensed under the MIT License; these hosted-service terms do not remove rights granted by that license. Third-party models, infrastructure, and connected clients have their own applicable terms.',
        ], links: [contactLink, { label: 'Juror MIT License', href: `${repository}/blob/main/LICENSE` }],
      },
      {
        id: 'service', title: 'The service and its limits',
        paragraphs: [
          'Juror runs configured AI reviewers, combines their findings, and presents review results and cost information. Optional browser QA runs configured journeys and records permitted evidence. Model output can be incomplete or wrong. A finding, absence of findings, or merge-confidence score is not a guarantee of correctness, security, or fitness for a purpose. You remain responsible for tests, access decisions, human review, and deployment.',
          'Features, model availability, and third-party integrations can change. No particular uptime, response time, or model is guaranteed unless a separate agreement says so. We may carry out maintenance and make changes needed for security or legal compliance.',
        ],
      },
      {
        id: 'accounts', title: 'Accounts and authorized use',
        paragraphs: [
          'Keep account access secure and workspace membership current. Connect only repositories, environments, and data you have authority to use and disclose for the selected processing. Review permissions before enabling automated runs, publishing, training collection, or a connected client. Notify us promptly about unauthorized access.',
          'Do not use Juror to violate law or third-party rights, access another tenant’s information, bypass usage restrictions, distribute malicious code through the service, or attack infrastructure or providers. Conduct security research through our coordinated reporting process.',
          'Run browser QA only against environments you are authorized to test. Use synthetic accounts and data, scope credentials to the task, and configure evidence capture and cleanup appropriately.',
        ],
      },
      {
        id: 'content', title: 'Your content and permissions',
        paragraphs: [
          'You retain your rights in submitted repositories, code, and other content. You authorize us and the providers required for a run to process that content to deliver, secure, and support the configured service, including publishing results when you enable it. This permission does not transfer ownership of your source code.',
          'Optional training collection is separately controlled in workspace settings and is disabled by default. Enabling it requires authority over the selected content and acceptance of the applicable collection settings. You are responsible for required notices and a lawful basis for personal data you submit. Contact us about a data-processing agreement before using the service where one is required.',
          'AI output may not be unique and may be subject to third-party rights or provider conditions. Check output before using it. Our service, branding, and website content remain protected by their applicable intellectual-property rights.',
        ],
      },
      {
        id: 'billing', title: 'Usage, prices, and payment',
        paragraphs: [
          'Applicable prices, credits, usage limits, and billing arrangements are shown in the service or an agreed order before paid use. You authorize charges for billable usage you or authorized workspace members initiate, including enabled automation. Stripe processes payments. You are responsible for applicable taxes as shown on your invoice.',
          'A review receipt distinguishes reported, estimated, partial, and unknown costs. Estimates are not provider invoices. Usage caps and admission limits follow the settings and billing rules displayed for your workspace. Trial credit has no cash value. Disputed charges should be reported promptly to the contact below; mandatory refund and consumer rights remain unaffected.',
        ], links: [contactLink],
      },
      {
        id: 'integrations', title: 'Connected clients',
        paragraphs: [
          'An MCP or plugin connection uses your Juror identity and existing workspace permissions. It does not grant arbitrary local-repository access or workspace administration. Starting or rerunning a hosted review requires a current preflight and explicit confirmation. You are responsible for reviewing the requested operation and any cost information before confirming.',
        ],
      },
      {
        id: 'termination', title: 'Suspension and ending use',
        paragraphs: [
          'You can stop future automated runs, revoke integrations, or request workspace deletion in Settings. Stopping use does not cancel charges already incurred. Export anything you need before deletion; deleting a workspace removes its access and retained workspace data through an asynchronous job.',
          'We may restrict or suspend access when reasonably necessary to address abuse, a security risk, unlawful use, unpaid charges, or a material breach. Where practical and lawful, we will explain the reason and provide an opportunity to resolve it. Records required by law or for legitimate legal claims may survive termination.',
        ],
      },
      {
        id: 'liability', title: 'Responsibility and liability',
        paragraphs: [
          'The service is provided as available, subject to any separate agreement and mandatory law. We do not warrant that AI output is error-free or that every defect will be found. Nothing in these terms excludes liability for intent, gross negligence, death or personal injury, fraud, an express guarantee, or liability that cannot lawfully be limited.',
          'For ordinary negligence, liability for breach of an essential contractual obligation is limited to the foreseeable damage typical of the contract. An essential obligation is one whose performance makes the contract possible and on which you may ordinarily rely. Other liability for ordinary negligence is excluded only to the extent permitted by law. Mandatory consumer protections remain unaffected.',
        ],
      },
      {
        id: 'law', title: 'Applicable law and changes',
        paragraphs: [
          'German law applies, subject to mandatory protections that apply where you live. These terms do not restrict a consumer’s mandatory rights or access to a competent court. No exclusive court is imposed on consumers by this page.',
          'We may update these terms for changes to the service or applicable law. We will give appropriate notice of material changes and obtain agreement where required. Updates do not retroactively change charges already incurred. If a provision is unenforceable, the remaining provisions continue to apply.',
        ],
      },
    ],
  },
  imprint: {
    title: 'Legal notice / Impressum',
    summary: 'Company and contact information for the operator of Juror.',
    sections: [
      { id: 'operator', title: 'Service provider', paragraphs: [COMPANY.name, COMPANY_ADDRESS, 'Juror is a product operated by this company.'] },
      { id: 'representation', title: 'Represented by', paragraphs: [`Managing director: ${COMPANY.managingDirector}.`] },
      { id: 'register', title: 'Commercial register', paragraphs: [`Register court: ${COMPANY.registerCourt}.`, `Registration number: ${COMPANY.registerNumber}.`] },
      { id: 'contact', title: 'Contact', paragraphs: ['For company, service, and privacy enquiries:'], links: [contactLink, { label: COMPANY.phone, href: COMPANY.phoneHref }] },
    ],
  },
  security: {
    title: 'Security at Juror',
    summary: 'How review execution, credentials, evidence, and vulnerability reporting are handled.',
    sections: [
      {
        id: 'execution', title: 'Review execution and access',
        paragraphs: ['Hosted reviews use isolated per-run execution environments. Review checkouts are read-only to reviewers, and source checkouts are cleaned up after the run. Privileged GitHub publishing credentials are kept out of model processes. Workspace roles and GitHub installation permissions control which repositories and results a user can access. These controls reduce risk; they do not make untrusted code or model output inherently safe.'],
      },
      {
        id: 'evidence', title: 'Reports and evidence',
        paragraphs: ['Reports are sanitized before storage. QA evidence lives in private object storage and is accessed through authenticated, short-lived links. Screenshots or report excerpts can still contain sensitive information from the configured task. Use test environments and synthetic data, and select evidence settings appropriate to your workspace.'],
      },
      {
        id: 'responsibilities', title: 'Your configuration matters',
        paragraphs: ['For the CLI and GitHub Action, protect provider keys, pin released revisions, and keep credentials out of untrusted fork workflows. Review configuration and repository rules are loaded from the trusted base revision. Keep human review and tests in your release process; neither model agreement nor a confidence score proves that a change is safe.'],
        links: [{ label: 'Threat model and boundaries', href: `${repository}/blob/main/docs/threat-model.md` }],
      },
      {
        id: 'reporting', title: 'Report a vulnerability privately',
        paragraphs: ['Use GitHub’s private vulnerability reporting form. Include the affected version, impact, and reproduction steps using synthetic data. Do not put credentials or vulnerability details in a public issue. If the form is unavailable, email us to arrange a private reporting channel.', 'We aim to acknowledge reports within three business days and provide an initial severity assessment within seven business days, as described in the repository security policy. These are communication targets, not guaranteed resolution times.'],
        links: [{ label: 'Report a vulnerability', href: `${repository}/security/advisories/new` }, { label: 'Security policy', href: `${repository}/blob/main/SECURITY.md` }, contactLink],
      },
    ],
  },
};
