/** Administration → Contracts: switch the module on, choose contract types and options, set rule defaults and lock them. */
import { useHelpContext } from '../../help/HelpPanel';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { ModuleSettings, type ModuleConfig } from '../../components/ModuleSettings';

export function ContractsSettings() {
  useHelpContext('contracts-settings');
  const { me } = useSession();
  const contractsOnly = me?.plan?.features.onboarding === false;
  return (
    <ModuleSettings<ModuleConfig> name="Contracts" endpoint="/admin/contracts" kindsKey="types" ruleNoun="contract"
      intro="Supplier and customer contracts: which types your team uses, the options switched on, and the defaults every new contract starts with."
      switchHelp="When off, the Contracts and Parties menus are hidden. Contracts and parties already recorded are kept."
      kinds={{ title: 'Contract types', help: 'Each type has its own number prefix. Some types are only for suppliers or only for customers.' }}
      kindExtra={(k) => <span className="muted small" style={{ marginInlineStart: 6 }}>
        <span className="mono">{String(k.prefix ?? '')}</span>
        {(k.directions as string[] | undefined)?.map((d) => <span key={d} className="badge sm" style={{ marginInlineStart: 4 }}>{d === 'BUY' ? 'Supplier' : 'Customer'}</span>)}
      </span>}>
      {() => contractsOnly ? <Alert kind="info">This workspace has the Contracts plan, without supplier onboarding. Parties are kept as light records; linking them to onboarded suppliers needs supplier onboarding.</Alert> : null}
    </ModuleSettings>
  );
}
