/** Administration → Sourcing: switch the module on, choose formats and sub-features, set rule defaults and lock them. */
import { useHelpContext } from '../../help/HelpPanel';
import { ModuleSettings, type KindRow, type ModuleConfig } from '../../components/ModuleSettings';
import { ApprovalLevelsCard, type ApprovalSetup } from '../../components/ApprovalLevelsCard';

export interface SourcingConfig extends ModuleConfig { formats: KindRow[]; approval?: ApprovalSetup; awardApproval?: ApprovalSetup }

export function SourcingSettings() {
  useHelpContext('sourcing-settings');
  return (
    <ModuleSettings<SourcingConfig> name="Sourcing" endpoint="/admin/sourcing" kindsKey="formats" ruleNoun="event"
      intro="RFQs and e-auctions: what is switched on for your buyers, and the rules every new event starts with."
      switchHelp="When off, there are no Sourcing menus, screens or emails for staff or suppliers. Your choices below are kept."
      kinds={{ title: 'Formats', help: 'Choose which kinds of event buyers can create.' }}>
      {(cfg) => <>
        {cfg.approval && <ApprovalCard kind="event" setup={cfg.approval} />}
        {cfg.awardApproval && <ApprovalCard kind="award" setup={cfg.awardApproval} />}
      </>}
    </ModuleSettings>
  );
}

/** The two sourcing approval flows (events before invitations, awards before letters) — the onboarding levels editor and tester. */
const FLOW_TEXT = {
  event: { title: 'Event approval', subject: 'events', field: 'event.estimatedValue', saved: 'Event approval flow saved. It applies to events submitted from now on.',
    intro: 'Before bidders are invited, an event goes through these levels top to bottom. A level with a rule is skipped for events that don’t match — for example, approval only above a value. If no level applies, the event is approved straight away. The person who owns an event can never approve it.' },
  award: { title: 'Award approval', subject: 'awards', field: 'award.value', saved: 'Award approval flow saved. It applies to awards proposed from now on.',
    intro: 'Before letters go to bidders and the award goes to the ERP, the proposed award goes through these levels. Rules can use the award value and whether everything went to the best price (“not best price”). If no level applies, the award is final straight away. The person who proposed an award can never approve it.' },
} as const;

function ApprovalCard({ kind, setup }: { kind: 'event' | 'award'; setup: ApprovalSetup }) {
  return <ApprovalLevelsCard endpoint={`/admin/sourcing/approval${kind === 'award' ? '?kind=award' : ''}`} setup={setup} text={FLOW_TEXT[kind]} />;
}
