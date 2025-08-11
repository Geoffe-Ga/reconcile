from __future__ import annotations
import difflib, datetime
import discord
from ..data.store import ReconcileStore
from .modals import ProposalModal

class ProposalView(discord.ui.View):
    def __init__(self, store: ReconcileStore, group_name: str, doc_id: int, prop_id: int) -> None:
        super().__init__(timeout=None)
        self.store = store
        self.group_name = group_name
        self.doc_id = doc_id
        self.prop_id = prop_id

    @discord.ui.button(label="Accept", style=discord.ButtonStyle.success)
    async def accept(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await self._vote(interaction, "accept")

    @discord.ui.button(label="Reject", style=discord.ButtonStyle.danger)
    async def reject(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await self._vote(interaction, "reject")

    async def _vote(self, interaction: discord.Interaction, choice: str) -> None:
        # Only allow members to vote
        group = self.store.groups.get(self.group_name)
        if not group or interaction.user.id not in group.members:
            await interaction.response.send_message("Only group members may vote on proposals.", ephemeral=True)
            return
        err = self.store.record_vote(self.group_name, self.doc_id, self.prop_id, interaction.user.id, choice)
        if err:
            await interaction.response.send_message(err, ephemeral=True)
        else:
            await interaction.response.send_message("Vote recorded.", ephemeral=True)

class VoteView(discord.ui.View):
    def __init__(self, store: ReconcileStore, rid: int, a_side: str, b_side: str):
        super().__init__(timeout=None)
        self.store = store
        self.rid = rid
        self.a_side = a_side
        self.b_side = b_side

    async def _cast(self, interaction: discord.Interaction, delta: int) -> None:
        rec = self.store.get_reconcile(self.rid)
        if not rec or rec.closed or rec.cancelled:
            await interaction.response.send_message("This vote is closed.", ephemeral=True)
            return
        # Determine eligible sides for this user
        sides = rec.side_for_member(interaction.user.id, self.store.groups)
        if not sides:
            await interaction.response.send_message("You are not eligible to vote in this reconcile.", ephemeral=True)
            return
        if len(sides) > 1:
            # both hats: prompt ephemeral chooser
            view = discord.ui.View()

            async def choose_and_vote(
                inter: discord.Interaction, chosen: str
            ) -> None:
                err = self.store.record_reconcile_vote(
                    self.rid, inter.user.id, chosen, delta
                )
                if err:
                    await inter.response.send_message(err, ephemeral=True)
                else:
                    await inter.response.send_message(
                        f"Vote recorded as {chosen}: {delta:+d}", ephemeral=True
                    )

            for s in sides:
                b = discord.ui.Button(
                    label=f"Vote as {s}", style=discord.ButtonStyle.secondary
                )

                async def handler(inter: discord.Interaction, side: str = s) -> None:
                    await choose_and_vote(inter, side)

                b.callback = handler
                view.add_item(b)
            await interaction.response.send_message(
                "Choose which hat to wear for this vote:",
                view=view,
                ephemeral=True,
            )
            return
        # Single side
        err = self.store.record_reconcile_vote(self.rid, interaction.user.id, sides[0], delta)
        if err:
            await interaction.response.send_message(err, ephemeral=True)
        else:
            await interaction.response.send_message(f"Vote recorded: {delta:+d}", ephemeral=True)

    @discord.ui.button(label="Strongly Against (-2)", style=discord.ButtonStyle.danger)
    async def b_m2(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await self._cast(interaction, -2)

    @discord.ui.button(label="Against (-1)", style=discord.ButtonStyle.danger)
    async def b_m1(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await self._cast(interaction, -1)

    @discord.ui.button(label="Neutral (0)", style=discord.ButtonStyle.secondary)
    async def b_0(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await self._cast(interaction, 0)

    @discord.ui.button(label="For (+1)", style=discord.ButtonStyle.success)
    async def b_p1(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await self._cast(interaction, +1)

    @discord.ui.button(label="Strongly For (+2)", style=discord.ButtonStyle.success)
    async def b_p2(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await self._cast(interaction, +2)

def progress_bar(avg: float) -> str:
    # map -2..+2 to 0..20 blocks
    blocks = int(round((avg + 2) / 4 * 20))
    return "▮" * blocks + "▯" * (20 - blocks)

def reconcile_embed(store: ReconcileStore, rid: int) -> discord.Embed:
    rec = store.get_reconcile(rid)
    if not rec:
        return discord.Embed(
            title="Reconcile", description="Not found.", color=discord.Color.red()
        )
    title = (
        f"Reconcile: {rec.a_side} ↔ {rec.b_side}"
        if rec.is_group_vs_group()
        else f"Reconcile: {rec.a_side.replace('solo:', '')} → {rec.b_side}"
    )
    e = discord.Embed(title=title, color=discord.Color.blurple())
    t = rec.tallies()
    a_cnt, a_avg = t[rec.a_side]
    b_cnt, b_avg = t[rec.b_side]
    e.add_field(
        name=f"{rec.a_side}",
        value=f"Votes: {a_cnt}\nAvg: {a_avg:+.2f}\n{progress_bar(a_avg)}",
        inline=True,
    )
    e.add_field(
        name=f"{rec.b_side}",
        value=f"Votes: {b_cnt}\nAvg: {b_avg:+.2f}\n{progress_bar(b_avg)}",
        inline=True,
    )
    e.set_footer(
        text=f"Closes {datetime.datetime.utcfromtimestamp(rec.close_ts).isoformat()}Z"
    )
    if rec.closed or rec.cancelled:
        state = "CANCELLED" if rec.cancelled else ("PASSED" if rec.passes() else "FAILED")
        e.description = f"Vote closed: {state}"
    return e

class DocumentView(discord.ui.View):
    def __init__(self, store: ReconcileStore, group_name: str, doc_id: int) -> None:
        super().__init__(timeout=None)
        self.store = store
        self.group_name = group_name
        self.doc_id = doc_id

    @discord.ui.button(label="View Full Document", style=discord.ButtonStyle.secondary)
    async def view_full(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        try:
            doc = self.store.get_document(self.group_name, self.doc_id)
        except Exception:
            await interaction.followup.send("Failed to load document.", ephemeral=True)
            return
        if not doc:
            await interaction.followup.send("Document not found.", ephemeral=True)
            return
        text = f"**{doc.title}**\n\n{doc.content}"
        if len(text) > 1900:
            text = text[:1900] + "…"
        await interaction.followup.send(text, ephemeral=True)

    @discord.ui.button(label="Propose Edit", style=discord.ButtonStyle.primary)
    async def propose(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        try:
            doc = self.store.get_document(self.group_name, self.doc_id)
        except Exception:
            await interaction.response.send_message("Failed to load document.", ephemeral=True)
            return
        if not doc:
            await interaction.response.send_message("Document not found.", ephemeral=True)
            return
        modal = ProposalModal(self.store, self.group_name, self.doc_id)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="View Proposals", style=discord.ButtonStyle.secondary)
    async def view_props(self, button: discord.ui.Button, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        try:
            doc = self.store.get_document(self.group_name, self.doc_id)
        except Exception:
            await interaction.followup.send("Failed to load document.", ephemeral=True)
            return
        if not doc:
            await interaction.followup.send("Document not found.", ephemeral=True)
            return
        try:
            proposals = doc.proposals
        except Exception:
            await interaction.followup.send("Failed to load proposals.", ephemeral=True)
            return
        if not proposals:
            await interaction.followup.send("No proposals yet.", ephemeral=True)
            return
        lines = []
        for pid, p in sorted(proposals.items()):
            lines.append(f"• #{pid} by <@{p.author_id}> — {'MERGED' if p.merged else 'OPEN'}")
        txt = "\n".join(lines)
        await interaction.followup.send(txt[:1800], ephemeral=True)
