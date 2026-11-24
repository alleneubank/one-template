import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Device } from '../features/native/device'

// native/AppNative holds the swift module and native/Device.kt the kotlin one.
// one prebuild compiles both into the app; features/native picks the platform's.
export default function NativeDemo() {
  const [info, setInfo] = useState<Record<string, string> | undefined>()

  useEffect(() => {
    void Device.info().then(setInfo)
  }, [])

  return (
    <View style={{ flex: 1, padding: 24, gap: 16, backgroundColor: '#fff' }}>
      <Text style={{ fontSize: 24, fontWeight: 'bold' }}>
        {info ? `Hello from ${info.language}` : 'Calling the native module…'}
      </Text>
      {info ? (
        <Text>
          {info.model} · {info.system}
        </Text>
      ) : null}
    </View>
  )
}
