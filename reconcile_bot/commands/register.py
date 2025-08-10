from __future__ import annotations

import discord
from discord.ext import commands

from ..data.store import ReconcileStore
from ..ui.modals import DocumentModal
from ..ui.views import DocumentView
from .utils import ensure_channels

def register_commands(bot: commands.Bot, store: ReconcileStore) -> None:
    tree = bot.tree

    @tree.command(name="create_group", description="Create a new group")
    @discord.app_commands.describe(name="Name of the group", description="Description of the group", tags="Comma-separated tags")
    async def create_group(interaction: discord.Interaction, name: str, description: str, tags: str) -> None:
        tag_list = [t.strip().lower() for t in tags.split(",") if t.strip()]
        err = store.create_group(name, description, tag_list, interaction.user.id)
        if err:
            await interaction.response.send_message(err, ephemeral=True)
        else:
            await interaction.response.send_message(f"Group `{name}` created and you were added as a member.", ephemeral=True)

    @tree.command(name="join_group", description="Join an existing group")
    @discord.app_commands.describe(name="Name of the group")
    async def join_group(interaction: discord.Interaction, name: str) -> None:
        err = store.join_group(name, interaction.user.id)
        if err:
            await interaction.response.send_message(err, ephemeral=True)
        else:
            await interaction.response.send_message(f"You joined `{name}`.", ephemeral=True)

    @tree.command(name="list_groups", description="List all groups")
    async def list_groups(interaction: discord.Interaction) -> None:
        if not store.groups:
            await interaction.response.send_message("No groups have been created yet.", ephemeral=True)
            return
        embed = discord.Embed(title="Groups")
        for group in store.groups.values():
            embed.add_field(
                name=group.name,
                value=f"Description: {group.description}\nTags: {', '.join(sorted(group.tags))}\nMembers: {len(group.members)}",
                inline=False,
            )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @tree.command(name="create_document", description="Create a document in a group")
    @discord.app_commands.describe(
        group_name="Group name",
        title="Document title",
        tags="Comma-separated tags",
    )
    async def create_document(
        interaction: discord.Interaction,
        group_name: str | None,
        title: str,
        tags: str,
    ) -> None:
        """Create a document, optionally letting the user pick the group via a dropdown.

        If ``group_name`` is provided we immediately open the modal for entering
        the document content.  Otherwise the user is presented with a dropdown
        listing all available groups and the modal is launched once a selection
        is made.
        """

        tag_list = [t.strip().lower() for t in tags.split(",") if t.strip()]

        async def launch_modal(inter: discord.Interaction, gname: str) -> None:
            group = store.groups.get(gname)
            if not group:
                await inter.response.send_message("Group not found.", ephemeral=True)
                return
            if inter.user.id not in group.members:
                await inter.response.send_message(
                    "You must be a member of the group to create documents.",
                    ephemeral=True,
                )
                return
            await inter.response.send_modal(DocumentModal(store, gname, title, tag_list))

        if group_name:
            await launch_modal(interaction, group_name)
            return

        options = [
            discord.SelectOption(label=name, value=name)
            for name in sorted(store.groups.keys())
        ]
        if not options:
            await interaction.response.send_message(
                "No groups have been created yet.", ephemeral=True
            )
            return

        view = discord.ui.View()
        select = discord.ui.Select(placeholder="Choose group", options=options)

        async def on_select(inter: discord.Interaction) -> None:
            await launch_modal(inter, select.values[0])

        select.callback = on_select
        view.add_item(select)
        await interaction.response.send_message(
            "Select a group for the document:", view=view, ephemeral=True
        )

    @create_document.autocomplete("group_name")
    async def create_document_group_name_autocomplete(
        interaction: discord.Interaction, current: str
    ):
        current_lower = current.lower()
        results = [
            discord.app_commands.Choice(name=name, value=name)
            for name, group in store.groups.items()
            if interaction.user.id in group.members
            and current_lower in name.lower()
        ]
        return results[:25]

    @tree.command(name="list_documents", description="List documents in a group")
    @discord.app_commands.describe(group_name="Group name")
    async def list_documents(interaction: discord.Interaction, group_name: str) -> None:
        group = store.groups.get(group_name)
        if not group:
            await interaction.response.send_message("Group not found.", ephemeral=True)
            return
        if not group.documents:
            await interaction.response.send_message("No documents in this group.", ephemeral=True)
            return
        embed = discord.Embed(title=f"Documents in {group_name}")
        for doc_id, doc in group.documents.items():
            embed.add_field(
                name=f"{doc_id}: {doc.title}",
                value=f"Tags: {', '.join(sorted(doc.tags))} | Proposals: {len(doc.proposals)}",
                inline=False,
            )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @list_documents.autocomplete("group_name")
    async def list_documents_group_name_autocomplete(
        interaction: discord.Interaction, current: str
    ):
        current_lower = current.lower()
        return [
            discord.app_commands.Choice(name=name, value=name)
            for name in store.groups.keys()
            if current_lower in name.lower()
        ][:25]

    @tree.command(name="view_document", description="View a document and interact with it")
    @discord.app_commands.describe(group_name="Group name", document_id="Document ID")
    async def view_document(interaction: discord.Interaction, group_name: str, document_id: int) -> None:
        group = store.groups.get(group_name)
        if not group:
            await interaction.response.send_message("Group not found.", ephemeral=True)
            return
        document = group.documents.get(document_id)
        if not document:
            await interaction.response.send_message("Document not found.", ephemeral=True)
            return
        embed = discord.Embed(title=document.title, description=document.content)
        embed.add_field(name="Tags", value=", ".join(sorted(document.tags)) or "(none)", inline=False)
        await interaction.response.send_message(embed=embed, view=DocumentView(store, group_name, document_id), ephemeral=True)

    @view_document.autocomplete("group_name")
    async def view_document_group_name_autocomplete(
        interaction: discord.Interaction, current: str
    ):
        current_lower = current.lower()
        return [
            discord.app_commands.Choice(name=name, value=name)
            for name in store.groups.keys()
            if current_lower in name.lower()
        ][:25]

    @view_document.autocomplete("document_id")
    async def view_document_document_id_autocomplete(
        interaction: discord.Interaction, current: str
    ):
        gname = getattr(interaction.namespace, "group_name", None)
        group = store.groups.get(gname)
        if not group:
            return []
        current_lower = current.lower()
        results = []
        for doc_id, doc in group.documents.items():
            if current_lower in str(doc_id) or current_lower in doc.title.lower():
                results.append(
                    discord.app_commands.Choice(
                        name=f"{doc_id}: {doc.title}", value=doc_id
                    )
                )
        return results[:25]

    @tree.command(name="recommend", description="Recommend groups based on your current memberships")
    async def recommend(interaction: discord.Interaction) -> None:
        names = store.recommendations_for(interaction.user.id, top_n=5)
        if not names:
            await interaction.response.send_message("No recommendations available yet.", ephemeral=True)
            return
        embed = discord.Embed(title="Recommended Groups", description="Based on the tags of the groups you've joined.")
        for n in names:
            g = store.groups.get(n)
            if g:
                embed.add_field(name=n, value=f"Tags: {', '.join(sorted(g.tags))}\nMembers: {len(g.members)}", inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @tree.command(name="my_groups", description="Show your groups")
    async def my_groups(interaction: discord.Interaction) -> None:
        groups = [g for g in store.groups.values() if interaction.user.id in g.members]
        if not groups:
            await interaction.response.send_message("You are not in any groups yet. Use `/join_group`.", ephemeral=True)
            return
        embed = discord.Embed(title="My Groups")
        for g in groups:
            embed.add_field(name=g.name, value=f"{g.description}\nMembers: {len(g.members)}", inline=False)
        # Add an ephemeral button to launch point-and-click reconcile
        view = discord.ui.View()
        b = discord.ui.Button(label="Start Reconcile", style=discord.ButtonStyle.primary)
        async def launch(inter):
            await inter.response.send_message("Open the picker below to start a Reconcile.", view=reconcile_picker_view(store, inter.guild.id), ephemeral=True)
        b.callback = launch
        view.add_item(b)
        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

    def reconcile_picker_view(store: ReconcileStore, guild_id: int) -> discord.ui.View:
        v = discord.ui.View(timeout=120)

        mode_select = discord.ui.Select(placeholder="Mode", options=[
            discord.SelectOption(label="Group ↔ Group", value="group↔group"),
            discord.SelectOption(label="Solo → Group", value="solo→group"),
        ])
        your_group = discord.ui.Select(placeholder="Your Group (memberships)")
        target_group = discord.ui.Select(placeholder="Target Group (others)")

        async def refresh(inter):
            # refresh options according to user
            member_id = inter.user.id
            my_groups = [g.name for g in store.groups.values() if member_id in g.members]
            other_groups = [g.name for g in store.groups.values() if member_id not in g.members]
            your_group.options = [discord.SelectOption(label=n, value=n) for n in my_groups[:25]] or [discord.SelectOption(label="No memberships", value="")]
            target_group.options = [discord.SelectOption(label=n, value=n) for n in other_groups[:25]] or [discord.SelectOption(label="No other groups", value="")]
        awaitable = refresh  # for closure use

        async def on_mode(inter):
            await awaitable(inter)
            await inter.response.edit_message(view=v)
        mode_select.callback = on_mode

        v.add_item(mode_select)
        v.add_item(your_group)
        v.add_item(target_group)

        launch = discord.ui.Button(label="Launch Vote", style=discord.ButtonStyle.success)
        async def do_launch(inter):
            m = mode_select.values[0] if mode_select.values else "group↔group"
            yg = your_group.values[0] if your_group.values else None
            tg = target_group.values[0] if target_group.values else None
            await start_reconcile_flow(inter, m, yg, tg, store, guild_id)
        launch.callback = do_launch
        v.add_item(launch)
        return v

    async def start_reconcile_flow(interaction: discord.Interaction, mode: str, your_group: str, target_group: str, store: ReconcileStore, guild_id: int):
        # fallback to picker if args missing
        if not mode or (mode == "group↔group" and (not your_group or not target_group)) or (mode == "solo→group" and not target_group):
            await interaction.response.send_message("Use the picker to select mode and groups.", view=reconcile_picker_view(store, interaction.guild.id), ephemeral=True)
            return
        # ensure channels exist
        docs_id, votes_id = await ensure_channels(interaction.guild)
        rid = store.create_reconcile(mode, your_group if mode=="group↔group" else f"solo:{interaction.user.display_name}", target_group, interaction.guild.id, votes_id)
        # create thread and initial embed
        votes_ch = interaction.guild.get_channel(votes_id)
        title = f"Reconcile: {your_group} ↔ {target_group}" if mode=="group↔group" else f"Reconcile: {interaction.user.display_name} → {target_group}"
        thread = await votes_ch.create_thread(name=title, type=discord.ChannelType.public_thread)
        from ..ui.views import VoteView, reconcile_embed
        embed = reconcile_embed(store, rid)
        view = VoteView(store, rid, store.get_reconcile(rid).a_side, store.get_reconcile(rid).b_side)
        msg = await thread.send(embed=embed, view=view)
        store.set_reconcile_message(rid, thread.id, msg.id)
        await interaction.response.send_message(f"Launched vote in {thread.mention}", ephemeral=True)

    @tree.command(name="reconcile", description="Start a reconciliation vote between groups or yourself → group")
    @discord.app_commands.describe(mode="Group ↔ Group or Solo → Group", your_group="One of your groups", target_group="Target group")
    async def reconcile_cmd(interaction: discord.Interaction, mode: str | None = None, your_group: str | None = None, target_group: str | None = None) -> None:
        await start_reconcile_flow(interaction, mode, your_group, target_group, store, interaction.guild.id)

    @tree.command(name="reconcile_status", description="Show a private status embed for a reconcile")
    async def reconcile_status(interaction: discord.Interaction, reconcile_id: int) -> None:
        from ..ui.views import reconcile_embed
        rec = store.get_reconcile(reconcile_id)
        if not rec:
            await interaction.response.send_message("Not found.", ephemeral=True)
            return
        await interaction.response.send_message(embed=reconcile_embed(store, reconcile_id), ephemeral=True)

    @tree.command(name="reconcile_cancel", description="Cancel an open reconcile (opener or server manager)")
    async def reconcile_cancel(interaction: discord.Interaction, reconcile_id: int) -> None:
        # allow manage_guild or opener (we did not save opener; keep simple: require manage guild for now)
        if not interaction.user.guild_permissions.manage_guild:
            await interaction.response.send_message("Only a server manager can cancel for now.", ephemeral=True)
            return
        ok = store.cancel_reconcile(reconcile_id)
        if not ok:
            await interaction.response.send_message("Reconcile not found.", ephemeral=True)
            return
        await interaction.response.send_message("Cancelled.", ephemeral=True)


