<script lang="ts">
  // Placeholder — the UI wave replaces this page (see SPEC-CLOUD.md "UI").
  let { data } = $props();
</script>

<main>
  <h1>Brainz Cloud</h1>
  <p>UI wave pending.</p>
  {#if data.user}
    <p>Signed in as {data.user.email}</p>
  {/if}
</main>
