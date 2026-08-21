ALTER TYPE "public"."audit_action" ADD VALUE 'member.role.set' BEFORE 'invite.create';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'role.create';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'role.update';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'role.delete';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'server.update';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'server.transfer';--> statement-breakpoint
ALTER TYPE "public"."audit_target_type" ADD VALUE 'role' BEFORE 'server';