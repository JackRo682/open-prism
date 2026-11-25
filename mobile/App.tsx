import { useState } from 'react';
import { Linking, Pressable, ScrollView, StatusBar, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const workspaceUrl = 'https://getopenprism.com';

export default function App() {
  const [openFailed, setOpenFailed] = useState(false);

  async function openWorkspace() {
    setOpenFailed(false);
    try {
      await Linking.openURL(workspaceUrl);
    } catch {
      setOpenFailed(true);
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>GetOpenPrism</Text>
          <Pressable accessibilityRole="link" onPress={openWorkspace}
            style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
            <Text style={styles.label}>Open web chat</Text>
          </Pressable>
          {openFailed && (
            <Text accessibilityRole="alert" selectable style={styles.error}>
              Open {workspaceUrl} in your browser to continue.
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8f9fc' },
  content: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 24 },
  title: { color: '#18233a', fontSize: 36, fontWeight: '700', textAlign: 'center' },
  link: { backgroundColor: '#234db1', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 24 },
  pressed: { opacity: 0.8 },
  label: { color: '#fff', fontSize: 17, fontWeight: '600' },
  error: { color: '#862a26', textAlign: 'center' },
});
