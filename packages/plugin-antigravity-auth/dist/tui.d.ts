import type { LocationRef, OpenCodeClient } from "@orchestra/client";
interface AccountMenuContext {
    readonly client: OpenCodeClient;
    readonly location: LocationRef | undefined;
    readonly data: {
        readonly location: {
            default(): LocationRef;
        };
    };
    readonly ui: {
        readonly dialog: {
            prompt(options: {
                title: string;
                description?: string;
            }): Promise<string | undefined>;
            alert(options: {
                title: string;
                message: string;
            }): Promise<void>;
            confirm(options: {
                title: string;
                message: string;
            }): Promise<boolean | undefined>;
            select<Value>(options: {
                title: string;
                options: ReadonlyArray<{
                    title: string;
                    value: Value;
                    description?: string;
                    category?: string;
                    disabled?: boolean;
                }>;
            }): Promise<Value | undefined>;
        };
        readonly toast: {
            show(options: {
                message: string;
                variant: "info" | "success";
            }): void;
        };
    };
    readonly keymap: {
        layer(factory: () => {
            mode: "global";
            commands: ReadonlyArray<{
                id: string;
                title: string;
                group: string;
                palette: true;
                slash: {
                    name: string;
                    aliases: string[];
                };
                run: () => Promise<void>;
            }>;
        }): void;
    };
}
export declare const AntigravityTuiPlugin: {
    id: string;
    setup(ctx: AccountMenuContext): void;
};
export default AntigravityTuiPlugin;
//# sourceMappingURL=tui.d.ts.map