from __future__ import annotations
import discord
from typing import List
from ..data.store import ReconcileStore

class DocumentModal(discord.ui.Modal, title="Create Document"):
    def __init__(self, store: ReconcileStore, group_name: str, title_text: str, tags: List[str]) -> None:
        super().__init__()
        self.store = store
        self.group_name = group_name
        self.title_text = title_text
        self.tags = tags
        self.content_input = discord.ui.TextInput(
            label="Document Content",
            style=discord.TextStyle.long,
            placeholder="Write the initial content of the document here...",
            required=True,
            max_length=4000,
        )
        self.add_item(self.content_input)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        content = self.content_input.value
        doc_id = self.store.create_document(self.group_name, self.title_text, self.tags, content)
        if doc_id is None:
            await interaction.response.send_message(
                f"Failed to create document in group `{self.group_name}`.",
                ephemeral=True,
            )
            return
        await interaction.response.send_message(
            f"Document `{self.title_text}` created with ID `{doc_id}` in group `{self.group_name}`.",
            ephemeral=True,
        )

class ProposalModal(discord.ui.Modal, title="Propose Edit"):
    def __init__(self, store: ReconcileStore, group_name: str, doc_id: int) -> None:
        super().__init__()
        self.store = store
        self.group_name = group_name
        self.doc_id = doc_id
        self.proposal_input = discord.ui.TextInput(
            label="Your proposed content",
            style=discord.TextStyle.long,
            placeholder="Enter the new content for this document...",
            required=True,
            max_length=4000,
        )
        self.add_item(self.proposal_input)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        prop_id = self.store.add_proposal(self.group_name, self.doc_id, interaction.user.id, self.proposal_input.value)
        if prop_id is None:
            await interaction.response.send_message("Failed to submit proposal.", ephemeral=True)
            return
        await interaction.response.send_message(
            f"Proposal `{prop_id}` submitted for document `{self.doc_id}` in group `{self.group_name}`.",
            ephemeral=True,
        )